// notify — Supabase DB webhook target for scan_results INSERT.
//
// Extracts opportunities from body.record.opportunities, filters for
// actionable spreads (>4% net, verdict SAFE/CAUTION, not belowThreshold),
// and sends up to 3 Telegram alerts per scan with inline action buttons.
//
// Env:
//   TELEGRAM_BOT_TOKEN — bot token from @BotFather
//   TELEGRAM_CHAT_ID   — numeric chat id to alert
//
// Triggered via: Dashboard → Database → Webhooks → scan_results INSERT.

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';

const MAX_ALERTS_PER_SCAN = 3;
const MIN_NET_SPREAD = 0.04;

interface Level {
  buyYesPlatform: 'kalshi' | 'polymarket';
  buyYesPrice: number;
  buyNoPlatform: 'kalshi' | 'polymarket';
  buyNoPrice: number;
  quantity: number;
  totalCost?: number;
  maxProfitDollars?: number;
}

interface Market {
  marketId?: string;
  title?: string;
  url?: string;
}

interface Opportunity {
  id?: string;
  kalshiMarket: Market;
  polyMarket: Market;
  verdict?: string;
  verdictReasoning?: string;
  levels: Level[];
  bestNetSpread: number;
  totalMaxProfit: number;
  annualizedReturn: number;
  daysToClose: number;
  belowThreshold?: boolean;
}

function slugifyId(marketId: string): string {
  return (marketId || '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .slice(0, 32)
    .replace(/^_+|_+$/g, '');
}

function htmlEscape(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatMessage(
  o: Opportunity,
): { text: string; reply_markup: unknown } {
  const lvl = o.levels[0];
  const qty = lvl.quantity;
  const yesCost = lvl.buyYesPrice * qty;
  const noCost = lvl.buyNoPrice * qty;
  const kalshiLeg = lvl.buyYesPlatform === 'kalshi' ? yesCost : noCost;
  const polyLeg = lvl.buyYesPlatform === 'polymarket' ? yesCost : noCost;
  const totalDeployed = kalshiLeg + polyLeg;
  const maxProfit = Math.round(o.totalMaxProfit);
  const netSpreadPct = (o.bestNetSpread * 100).toFixed(1);
  const apyPct = (o.annualizedReturn * 100).toFixed(1);
  const daysToClose = o.daysToClose.toFixed(1);
  const verdict = (o.verdict || 'CAUTION').toUpperCase();
  const emoji = verdict === 'SAFE' ? '🟢' : '🟡';

  const kTitle = htmlEscape(o.kalshiMarket.title || '(untitled)');
  const reasoning = htmlEscape(o.verdictReasoning || '');

  const buyYesLine =
    `Buy YES: <code>${lvl.buyYesPlatform} @ $${lvl.buyYesPrice.toFixed(4)}` +
    ` × ${qty} contracts = $${yesCost.toFixed(2)}</code>`;
  const buyNoLine =
    `Buy NO:  <code>${lvl.buyNoPlatform} @ $${lvl.buyNoPrice.toFixed(4)}` +
    ` × ${qty} contracts = $${noCost.toFixed(2)}</code>`;

  const text =
    `${emoji} <b>ARB SIGNAL — ${verdict}</b>\n\n` +
    `<b>${kTitle}</b>\n\n` +
    `${buyYesLine}\n` +
    `${buyNoLine}\n\n` +
    `💰 <b>Total deployed: $${totalDeployed.toFixed(2)}</b>\n` +
    `📈 <b>Max profit: $${maxProfit} (+${netSpreadPct}% net)</b>\n` +
    `⏱ Days to close: ${daysToClose}d  |  APY: <b>+${apyPct}%</b>\n\n` +
    (reasoning ? `<i>${reasoning}</i>` : '');

  const oppId = slugifyId(o.kalshiMarket.marketId || o.id || '');
  const row1 = [
    {
      text: `✅ Execute $${totalDeployed.toFixed(2)}`,
      callback_data: `buy_${oppId}`,
    },
    { text: '❌ Skip', callback_data: `skip_${oppId}` },
  ];
  const row2: Array<{ text: string; url: string }> = [];
  if (o.kalshiMarket.url) {
    row2.push({ text: '📈 View on Kalshi ↗', url: o.kalshiMarket.url });
  }
  if (o.polyMarket.url) {
    row2.push({ text: '📊 View on Polymarket ↗', url: o.polyMarket.url });
  }
  const inline_keyboard: unknown[][] = [row1];
  if (row2.length > 0) inline_keyboard.push(row2);

  return { text, reply_markup: { inline_keyboard } };
}

async function sendTelegram(
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[notify] telegram sendMessage failed', res.status, body);
  }
}

serve(async (req) => {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return new Response('missing telegram env', { status: 500 });
    }
    const body = await req.json().catch(() => ({} as any));
    const record = body?.record ?? body?.new ?? {};
    const opportunities: Opportunity[] = Array.isArray(record?.opportunities)
      ? record.opportunities
      : [];

    const filtered = opportunities.filter((o) => {
      if (!o || !Array.isArray(o.levels) || o.levels.length === 0) return false;
      if (typeof o.bestNetSpread !== 'number') return false;
      if (o.bestNetSpread <= MIN_NET_SPREAD) return false;
      const v = (o.verdict || '').toUpperCase();
      if (v !== 'SAFE' && v !== 'CAUTION') return false;
      if (o.belowThreshold === true) return false;
      return true;
    });

    console.log(
      `[notify] scan has ${opportunities.length} opps, ${filtered.length} actionable`,
    );

    if (filtered.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, sent: 0, total: opportunities.length }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    const toSend = filtered.slice(0, MAX_ALERTS_PER_SCAN);
    let sent = 0;
    for (const o of toSend) {
      try {
        const { text, reply_markup } = formatMessage(o);
        await sendTelegram({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup,
        });
        sent++;
      } catch (err) {
        console.error('[notify] failed to send alert', err);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, sent, eligible: filtered.length }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[notify] handler error', err);
    return new Response('error: ' + String(err), { status: 500 });
  }
});
