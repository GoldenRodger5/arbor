// trade — Telegram webhook handler for the HIL trade flow.
//
// Handles two Telegram update types:
//   1. callback_query  → inline button taps from the notify alerts
//                        ("buy_<slug>" logs a pending position and edits
//                        the alert to show execution instructions;
//                        "skip_<slug>" collapses the alert).
//   2. message         → text commands. /done_<uuid> flips a pending
//                        position to "open". Everything else → hint reply.
//
// Env:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

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

async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    console.error(`[trade] tg ${method} failed`, res.status, JSON.stringify(json));
  }
  return json;
}

async function answerCallback(id: string, text?: string): Promise<void> {
  await tg('answerCallbackQuery', {
    callback_query_id: id,
    text: text ?? '',
  });
}

async function editMessage(
  chatId: number | string,
  messageId: number,
  text: string,
): Promise<void> {
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function sendMessage(chatId: number | string, text: string): Promise<void> {
  await tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

interface Level {
  buyYesPlatform: 'kalshi' | 'polymarket';
  buyYesPrice: number;
  buyNoPlatform: 'kalshi' | 'polymarket';
  buyNoPrice: number;
  quantity: number;
}

interface Opportunity {
  id?: string;
  kalshiMarket: { marketId?: string; title?: string; url?: string };
  polyMarket: { marketId?: string; title?: string; url?: string };
  verdict?: string;
  levels: Level[];
  bestNetSpread: number;
  totalMaxProfit: number;
  daysToClose: number;
  annualizedReturn: number;
}

async function findOpportunityBySlug(
  sb: ReturnType<typeof createClient>,
  slug: string,
): Promise<Opportunity | null> {
  // Pull latest few scan_results rows and search their opportunities
  // arrays. The webhook receives the INSERT immediately, but a user might
  // tap the button several scans later; look back at the 3 most recent.
  const { data, error } = await sb
    .from('scan_results')
    .select('opportunities, scanned_at')
    .order('scanned_at', { ascending: false })
    .limit(3);
  if (error) {
    console.error('[trade] scan_results query failed', error);
    return null;
  }
  for (const row of data ?? []) {
    const opps = (row as any).opportunities as Opportunity[] | null;
    if (!Array.isArray(opps)) continue;
    for (const o of opps) {
      if (slugifyId(o.kalshiMarket?.marketId || o.id || '') === slug) {
        return o;
      }
    }
  }
  return null;
}

function computeDeployAndProfit(o: Opportunity): {
  totalDeployed: number;
  maxProfit: number;
  kalshiLeg: number;
  polyLeg: number;
} {
  const lvl = o.levels[0];
  const qty = lvl.quantity;
  const yesCost = lvl.buyYesPrice * qty;
  const noCost = lvl.buyNoPrice * qty;
  const kalshiLeg = lvl.buyYesPlatform === 'kalshi' ? yesCost : noCost;
  const polyLeg = lvl.buyYesPlatform === 'polymarket' ? yesCost : noCost;
  return {
    totalDeployed: kalshiLeg + polyLeg,
    maxProfit: Math.round(o.totalMaxProfit),
    kalshiLeg,
    polyLeg,
  };
}

function kalshiSideFor(o: Opportunity): 'YES' | 'NO' {
  const lvl = o.levels[0];
  return lvl.buyYesPlatform === 'kalshi' ? 'YES' : 'NO';
}
function polySideFor(o: Opportunity): 'YES' | 'NO' {
  const lvl = o.levels[0];
  return lvl.buyYesPlatform === 'polymarket' ? 'YES' : 'NO';
}

async function handleBuy(
  sb: ReturnType<typeof createClient>,
  slug: string,
  chatId: number,
  messageId: number,
  callbackId: string,
): Promise<void> {
  const opp = await findOpportunityBySlug(sb, slug);
  if (!opp) {
    await answerCallback(callbackId, 'Opportunity not found in recent scans');
    await editMessage(
      chatId,
      messageId,
      '⚠️ <b>Opportunity not found</b>\nCouldn\'t match this alert against the 3 most recent scans.',
    );
    return;
  }

  const { totalDeployed, maxProfit } = computeDeployAndProfit(opp);
  const kSide = kalshiSideFor(opp);
  const pSide = polySideFor(opp);
  const kTitle = opp.kalshiMarket.title || '';
  const pTitle = opp.polyMarket.title || '';

  const insert = {
    kalshi_market_id: opp.kalshiMarket.marketId ?? null,
    kalshi_title: kTitle,
    poly_market_id: opp.polyMarket.marketId ?? null,
    poly_title: pTitle,
    status: 'pending',
    intended_kalshi_side: kSide.toLowerCase(),
    intended_poly_side: pSide.toLowerCase(),
    opportunity_id: slug,
  };
  const { data: row, error } = await sb
    .from('positions')
    .insert(insert)
    .select('id')
    .single();

  if (error || !row) {
    console.error('[trade] positions insert failed', error);
    await answerCallback(callbackId, 'DB insert failed');
    await editMessage(
      chatId,
      messageId,
      `⚠️ <b>Position insert failed</b>\n<code>${htmlEscape(
        error?.message ?? 'unknown',
      )}</code>`,
    );
    return;
  }

  await answerCallback(callbackId, 'Logged as pending');

  const uuid = (row as any).id;
  const body =
    `⏳ <b>Position logged as PENDING</b>\n\n` +
    `${htmlEscape(kTitle)}\n\n` +
    `Total deployed: $${totalDeployed.toFixed(2)}\n` +
    `Max profit: $${maxProfit}\n\n` +
    `✅ Execute both legs now:\n\n` +
    `KALSHI: Buy ${kSide} on ${htmlEscape(kTitle)}\n` +
    `POLYMARKET: Buy ${pSide} on ${htmlEscape(pTitle)}\n\n` +
    `Position ID: <code>${uuid}</code>\n\n` +
    `Mark complete: /done_${uuid}`;
  await editMessage(chatId, messageId, body);
}

async function handleSkip(
  slug: string,
  chatId: number,
  messageId: number,
  callbackId: string,
  originalText?: string,
): Promise<void> {
  await answerCallback(callbackId, 'Skipped');
  // Extract the kalshi title from the original message if we can; falls
  // back to the slug so the user has some context after collapse.
  let label = slug;
  if (originalText) {
    const lines = originalText.split('\n');
    // Format: "🟢 ARB SIGNAL — SAFE" "" "<title>" — the title is the
    // first non-empty line after the header.
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t) {
        label = t;
        break;
      }
    }
  }
  await editMessage(
    chatId,
    messageId,
    `⏭ <b>Skipped</b>\n${htmlEscape(label)}`,
  );
}

async function handleMessage(
  sb: ReturnType<typeof createClient>,
  msg: any,
): Promise<void> {
  const chatId = msg?.chat?.id;
  const text: string = msg?.text ?? '';
  if (!chatId) return;

  const doneMatch = text.match(/^\/done_([0-9a-fA-F-]{36})/);
  if (doneMatch) {
    const uuid = doneMatch[1];
    const { error } = await sb
      .from('positions')
      .update({ status: 'open' })
      .eq('id', uuid);
    if (error) {
      console.error('[trade] positions update failed', error);
      await sendMessage(
        chatId,
        `⚠️ Update failed: <code>${htmlEscape(error.message)}</code>`,
      );
      return;
    }
    await sendMessage(
      chatId,
      `✅ Position <code>${uuid}</code> marked as OPEN.\n` +
        `Settlement will be tracked automatically.`,
    );
    return;
  }

  await sendMessage(
    chatId,
    'Use the buttons in the alert message to execute or skip trades.',
  );
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('ok', { status: 200 });
  }
  if (
    !TELEGRAM_BOT_TOKEN ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return new Response('missing env', { status: 500 });
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let update: any = {};
  try {
    update = await req.json();
  } catch (_err) {
    return new Response('bad json', { status: 400 });
  }

  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      const data: string = cq.data ?? '';
      const chatId = cq.message?.chat?.id;
      const messageId = cq.message?.message_id;
      const originalText: string | undefined = cq.message?.text;
      if (!chatId || !messageId) {
        await answerCallback(cq.id, 'Invalid callback');
        return new Response('ok');
      }
      if (data.startsWith('buy_')) {
        await handleBuy(sb, data.slice(4), chatId, messageId, cq.id);
      } else if (data.startsWith('skip_')) {
        await handleSkip(data.slice(5), chatId, messageId, cq.id, originalText);
      } else {
        await answerCallback(cq.id, 'Unknown action');
      }
    } else if (update.message) {
      await handleMessage(sb, update.message);
    }
  } catch (err) {
    console.error('[trade] handler error', err);
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
