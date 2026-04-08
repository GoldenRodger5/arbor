import Anthropic from '@anthropic-ai/sdk';
import config from '@/config';
import type { ResolutionVerdict, UnifiedMarket } from '@/types';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  dangerouslyAllowBrowser: true,
});

export interface VerifyResult {
  verdict: ResolutionVerdict;
  reasoning: string;
  riskFactors: string[];
}

const SYSTEM_PROMPT =
  'You are a prediction market analyst specializing in resolution criteria. ' +
  'Compare two markets from different platforms and determine if they will ' +
  'definitionally resolve to the same outcome. Be conservative — if there is ' +
  'any meaningful difference in resolution conditions, flag it. Respond only ' +
  'with valid JSON, no markdown backticks.';

function buildUserMessage(kalshi: UnifiedMarket, poly: UnifiedMarket): string {
  const kalshiCriteria = kalshi.resolutionCriteria ?? 'Not explicitly stated';
  const polyCriteria = poly.resolutionCriteria ?? 'Not explicitly stated';
  return (
    'Compare these prediction markets:\n\n' +
    'KALSHI:\n' +
    `Title: ${kalshi.title}\n` +
    `Resolution criteria: ${kalshiCriteria}\n\n` +
    'POLYMARKET:\n' +
    `Title: ${poly.title}\n` +
    `Resolution criteria: ${polyCriteria}\n\n` +
    'Return JSON only:\n' +
    '{\n' +
    '  "verdict": "SAFE" | "CAUTION" | "SKIP",\n' +
    '  "reasoning": "one sentence",\n' +
    '  "risk_factors": ["difference 1", "difference 2"]\n' +
    '}\n\n' +
    'SAFE = identical resolution, guaranteed same outcome\n' +
    'CAUTION = similar but subtle differences exist\n' +
    'SKIP = different resolution conditions, do not trade'
  );
}

function isVerdict(value: unknown): value is ResolutionVerdict {
  return value === 'SAFE' || value === 'CAUTION' || value === 'SKIP';
}

export async function verifyPair(
  kalshi: UnifiedMarket,
  poly: UnifiedMarket,
): Promise<VerifyResult> {
  if (!config.anthropic.apiKey) {
    return {
      verdict: 'PENDING',
      reasoning: 'No API key configured',
      riskFactors: [],
    };
  }

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildUserMessage(kalshi, poly) },
      ],
    });

    // Concatenate text blocks from the response.
    const text = response.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> =>
        block.type === 'text',
      )
      .map((block) => block.text)
      .join('')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        verdict: 'CAUTION',
        reasoning: 'Failed to parse Claude response',
        riskFactors: [],
      };
    }

    const obj = parsed as {
      verdict?: unknown;
      reasoning?: unknown;
      risk_factors?: unknown;
    };

    const verdict: ResolutionVerdict = isVerdict(obj.verdict)
      ? obj.verdict
      : 'CAUTION';
    const reasoning =
      typeof obj.reasoning === 'string' ? obj.reasoning : '';
    const riskFactors = Array.isArray(obj.risk_factors)
      ? obj.risk_factors.filter((r): r is string => typeof r === 'string')
      : [];

    return { verdict, reasoning, riskFactors };
  } catch {
    return {
      verdict: 'CAUTION',
      reasoning: 'Claude API error',
      riskFactors: [],
    };
  }
}
