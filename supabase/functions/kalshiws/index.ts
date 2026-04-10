// kalshiws — Kalshi WebSocket listener for instant game-market detection.
//
// Uses WebSocketStream (Deno 2.5+) which supports custom headers on the
// HTTP upgrade handshake — required for Kalshi RSA-PSS auth.
// Falls back gracefully if WebSocketStream is unavailable.
//
// Connects, authenticates, subscribes to market_lifecycle_v2, listens
// for 55 seconds, processes any new game-winner markets, then exits.
// Scheduled via pg_cron every minute for near-continuous coverage.
//
// Env: KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY,
//      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.203.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const KALSHI_WS_URL    = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const KALSHI_BASE      = 'https://api.elections.kalshi.com/trade-api/v2';
const TG_API           = `https://api.telegram.org/bot${Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''}`;
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';
const LISTEN_MS        = 55_000;
const GAME_RE          = /^KX(MLB|NBA|NFL|NHL|MLS)GAME/;
const MIN_SPREAD_ALERT = 0.03;

// ─────────────────────────────────────────────────────────────────────────────
// RSA-PSS auth
// ─────────────────────────────────────────────────────────────────────────────

let _key: CryptoKey | null = null;

function pemToAB(pem: string): ArrayBuffer {
  const c = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const b = atob(c); const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u.buffer;
}
function b64(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf); let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

async function getCryptoKey(): Promise<CryptoKey> {
  if (_key) return _key;
  const privKey = Deno.env.get('KALSHI_PRIVATE_KEY') ?? '';
  _key = await globalThis.crypto.subtle.importKey(
    'pkcs8', pemToAB(privKey),
    { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign'],
  );
  return _key;
}

async function signForWs(): Promise<{ ts: string; sig: string }> {
  const key  = await getCryptoKey();
  const ts   = String(Date.now());
  const path = '/trade-api/ws/v2';
  const sig  = await globalThis.crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 }, key,
    new TextEncoder().encode(`${ts}GET${path}`),
  );
  return { ts, sig: b64(sig) };
}

async function kalshiAuthHeaders(method: string, path: string): Promise<Record<string, string>> {
  const key = await getCryptoKey();
  const ts  = String(Date.now());
  const full = path.startsWith('/trade-api/') ? path : `/trade-api/v2${path}`;
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 }, key,
    new TextEncoder().encode(`${ts}${method}${full}`),
  );
  return {
    'KALSHI-ACCESS-KEY': Deno.env.get('KALSHI_API_KEY_ID') ?? '',
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': b64(sig),
    'Content-Type': 'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Team parsing
// ─────────────────────────────────────────────────────────────────────────────

const TEAM_MAPS: Record<string, Record<string, string>> = {
  MLB: {ARI:'diamondbacks',ATL:'braves',BAL:'orioles',BOS:'red sox',CHC:'cubs',CIN:'reds',CLE:'guardians',COL:'rockies',CWS:'white sox',DET:'tigers',HOU:'astros',KCR:'royals',LAA:'angels',LAD:'dodgers',MIA:'marlins',MIL:'brewers',MIN:'twins',NYM:'mets',NYY:'yankees',OAK:'athletics',ATH:'athletics',PHI:'phillies',PIT:'pirates',SDP:'padres',SEA:'mariners',SFG:'giants',STL:'cardinals',TBR:'rays',TEX:'rangers',TOR:'blue jays',WSH:'nationals'},
  NBA: {ATL:'hawks',BOS:'celtics',BKN:'nets',CHI:'bulls',CLE:'cavaliers',DAL:'mavericks',DEN:'nuggets',DET:'pistons',GSW:'warriors',HOU:'rockets',IND:'pacers',LAC:'clippers',LAL:'lakers',MEM:'grizzlies',MIA:'heat',MIL:'bucks',MIN:'timberwolves',NOP:'pelicans',NYK:'knicks',OKC:'thunder',ORL:'magic',PHI:'sixers',PHX:'suns',POR:'blazers',SAC:'kings',SAS:'spurs',TOR:'raptors',UTA:'jazz',WAS:'wizards'},
  NFL: {ARI:'cardinals',ATL:'falcons',BAL:'ravens',BUF:'bills',CAR:'panthers',CHI:'bears',CIN:'bengals',CLE:'browns',DAL:'cowboys',DEN:'broncos',DET:'lions',GB:'packers',HOU:'texans',IND:'colts',JAC:'jaguars',KC:'chiefs',LV:'raiders',LAC:'chargers',LAR:'rams',MIA:'dolphins',MIN:'vikings',NE:'patriots',NO:'saints',NYG:'giants',NYJ:'jets',PHI:'eagles',PIT:'steelers',SF:'49ers',SEA:'seahawks',TB:'buccaneers',TEN:'titans',WAS:'commanders'},
  NHL: {ANA:'ducks',BOS:'bruins',BUF:'sabres',CGY:'flames',CAR:'hurricanes',CHI:'blackhawks',COL:'avalanche',CBJ:'blue jackets',DAL:'stars',DET:'red wings',EDM:'oilers',FLA:'panthers',LAK:'kings',MIN:'wild',MTL:'canadiens',NSH:'predators',NJD:'devils',NYI:'islanders',NYR:'rangers',OTT:'senators',PHI:'flyers',PIT:'penguins',SJS:'sharks',SEA:'kraken',STL:'blues',TBL:'lightning',TOR:'maple leafs',VAN:'canucks',VGK:'golden knights',WSH:'capitals',WPG:'jets'},
};

function parseTeams(ticker: string): { sport: string; teams: string[] } | null {
  const m = ticker.match(/^KX(MLB|NBA|NFL|NHL)GAME-/);
  if (!m) return null;
  const sport = m[1]; const tail = ticker.split('-').pop() ?? '';
  const codes = (tail.match(/[A-Z]+$/) ?? [])[0] ?? '';
  const map = TEAM_MAPS[sport] ?? {};
  const t = (a: string, b: string) => map[a] && map[b] ? [map[a], map[b]] : null;
  let teams: string[] | null = null;
  if (codes.length === 6) teams = t(codes.slice(0,3), codes.slice(3));
  else if (codes.length === 5) teams = t(codes.slice(0,2), codes.slice(2)) ?? t(codes.slice(0,3), codes.slice(3));
  else if (codes.length === 4) teams = t(codes.slice(0,2), codes.slice(2));
  return teams ? { sport, teams } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram + Supabase helpers
// ─────────────────────────────────────────────────────────────────────────────

function htmlEsc(s: string) { return (s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function slugify(s: string) { return (s??'').replace(/[^a-zA-Z0-9]+/g,'_').slice(0,32).replace(/^_+|_+$/g,''); }

async function sendGameAlert(ticker: string, title: string, sport: string, teams: string[], yesAsk: number, noAsk: number) {
  if (!TELEGRAM_CHAT_ID) return;
  const oppId = slugify(ticker);
  const text =
    `🚨 <b>NEW GAME LISTED — INSTANT ALERT</b>\n\n` +
    `<b>${htmlEsc(teams[0]??'')} vs ${htmlEsc(teams[1]??'')}</b> — ${sport}\n` +
    `${htmlEsc(title)}\n\n` +
    `Detected 0s after Kalshi listing.\nSpread window may close in minutes.\n\n` +
    `YES ask: <code>$${yesAsk.toFixed(4)}</code>  |  NO ask: <code>$${noAsk.toFixed(4)}</code>\n` +
    `Implied total: <code>$${(yesAsk+noAsk).toFixed(4)}</code>\n` +
    `Raw gross: <code>${((1-yesAsk-noAsk)*100).toFixed(2)}%</code>`;
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID, text, parse_mode:'HTML', disable_web_page_preview:true,
      reply_markup: { inline_keyboard: [[
        {text:`✅ Execute NOW`, callback_data:`buy_${oppId}`},
        {text:'❌ Skip', callback_data:`skip_${oppId}`},
      ]]},
    }),
  });
}

function getSb() {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return (url && key) ? createClient(url, key) : null;
}

async function checkNewGameMarket(ticker: string, title: string) {
  const info = parseTeams(ticker);
  if (!info) return;
  // Fetch orderbook for this specific market.
  try {
    const headers = await kalshiAuthHeaders('GET', '/markets/orderbooks');
    const res = await fetch(`${KALSHI_BASE}/markets/orderbooks?tickers=${ticker}`, { headers });
    if (!res.ok) return;
    const data = await res.json() as { orderbooks?: any[] };
    const ob = data.orderbooks?.[0];
    if (!ob?.orderbook_fp) return;
    const yesRaw = ob.orderbook_fp.yes_dollars ?? [];
    const noRaw  = ob.orderbook_fp.no_dollars ?? [];
    // Best asks: YES ask = 1 - top NO bid, NO ask = 1 - top YES bid
    const topNoBid  = noRaw.length > 0 ? parseFloat(noRaw[0][0]) : 0;
    const topYesBid = yesRaw.length > 0 ? parseFloat(yesRaw[0][0]) : 0;
    const yesAsk = topNoBid > 0 ? 1 - topNoBid : 0;
    const noAsk  = topYesBid > 0 ? 1 - topYesBid : 0;
    if (yesAsk <= 0 || noAsk <= 0) return;
    const rawGross = 1 - yesAsk - noAsk;
    console.log(`[kalshiws] ${ticker} orderbook: yesAsk=${yesAsk.toFixed(4)} noAsk=${noAsk.toFixed(4)} gross=${(rawGross*100).toFixed(2)}%`);
    if (rawGross > MIN_SPREAD_ALERT) {
      await sendGameAlert(ticker, title, info.sport, info.teams, yesAsk, noAsk);
    }
    // Upsert to known_game_markets.
    const sb = getSb();
    if (sb) {
      await sb.from('known_game_markets').upsert({
        platform: 'kalshi', market_id: ticker, title,
        sport_league: info.sport.toLowerCase(),
        home_team: info.teams[0]??null, away_team: info.teams[1]??null,
        last_checked_at: new Date().toISOString(),
      }, { onConflict: 'platform,market_id' }).catch(() => {});
    }
  } catch (err) {
    console.error('[kalshiws] checkNewGameMarket threw', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

serve(async () => {
  const startMs = Date.now();
  let connected = false;
  let messagesReceived = 0;
  let gameMarketsDetected = 0;
  let alertsFired = 0;
  const errors: string[] = [];
  const newMarkets: string[] = [];

  const apiKeyId = Deno.env.get('KALSHI_API_KEY_ID') ?? '';
  if (!apiKeyId || !Deno.env.get('KALSHI_PRIVATE_KEY')) {
    return new Response(JSON.stringify({ ok: false, error: 'missing Kalshi creds' }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  // Sign for the WebSocket upgrade handshake.
  const { ts, sig } = await signForWs();

  // Try WebSocketStream first (supports custom headers on upgrade).
  // Fall back to plain WebSocket with URL-encoded auth if WSS not available.
  const hasWSS = typeof (globalThis as any).WebSocketStream === 'function';
  console.log('[kalshiws] WebSocketStream available:', hasWSS);

  // If neither WebSocketStream (custom headers) nor a workaround is available,
  // we can't authenticate with Kalshi's WS endpoint. Exit gracefully and rely
  // on fastpoll (60s polling) as the primary detection mechanism.
  if (!hasWSS) {
    console.log('[kalshiws] Supabase Deno runtime lacks WebSocketStream — falling back to plain WebSocket (may fail auth)');
  }

  if (hasWSS) {
    try {
      const wss = new (globalThis as any).WebSocketStream(KALSHI_WS_URL, {
        headers: {
          'KALSHI-ACCESS-KEY': apiKeyId,
          'KALSHI-ACCESS-SIGNATURE': sig,
          'KALSHI-ACCESS-TIMESTAMP': ts,
        },
      });

      const { readable, writable } = await Promise.race([
        wss.opened,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('WS connect timeout')), 10_000)),
      ]) as { readable: ReadableStream; writable: WritableStream };

      connected = true;
      console.log('[kalshiws] connected via WebSocketStream');

      // Subscribe to market_lifecycle_v2.
      const writer = writable.getWriter();
      await writer.write(JSON.stringify({
        id: 1, cmd: 'subscribe',
        params: { channels: ['market_lifecycle_v2'] },
      }));
      writer.releaseLock();

      // Listen for messages until deadline.
      const deadline = Date.now() + LISTEN_MS;
      const reader = readable.getReader();

      while (Date.now() < deadline) {
        const timeLeft = deadline - Date.now();
        const result = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), timeLeft)),
        ]);
        if (result.done) break;

        messagesReceived++;
        try {
          const msg = JSON.parse(result.value as string);
          // Log first few messages for debugging.
          if (messagesReceived <= 3) console.log('[kalshiws] msg:', JSON.stringify(msg).slice(0, 300));

          const mTicker = msg?.msg?.market_ticker ?? msg?.msg?.ticker ?? msg?.market_ticker ?? '';
          if (GAME_RE.test(mTicker)) {
            gameMarketsDetected++;
            const mTitle = msg?.msg?.title ?? msg?.msg?.market_title ?? mTicker;
            newMarkets.push(mTicker);
            console.log('[kalshiws] NEW GAME MARKET:', mTicker);
            await checkNewGameMarket(mTicker, mTitle);
            alertsFired++; // approximate — checkNewGameMarket sends if spread > 3%
          }
        } catch { /* ignore parse errors */ }
      }

      await reader.cancel();
      try { wss.close(); } catch {}

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push('WSS: ' + msg);
      console.error('[kalshiws] WebSocketStream error:', msg);
    }
  } else {
    // WebSocketStream not available — try plain WebSocket with auth in protocol header.
    // Kalshi may not accept this, but it's the only option without custom upgrade headers.
    try {
      const ws = new WebSocket(KALSHI_WS_URL);
      const done = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, LISTEN_MS);
        ws.onopen = () => {
          connected = true;
          console.log('[kalshiws] connected via WebSocket (plain)');
          // Try sending auth as a message (may or may not work).
          ws.send(JSON.stringify({
            id: 1, cmd: 'subscribe',
            params: {
              channels: ['market_lifecycle_v2'],
              'kalshi-access-key': apiKeyId,
              'kalshi-access-timestamp': ts,
              'kalshi-access-signature': sig,
            },
          }));
        };
        ws.onmessage = async (ev) => {
          messagesReceived++;
          try {
            const data = JSON.parse(ev.data as string);
            if (messagesReceived <= 3) console.log('[kalshiws] plain msg:', JSON.stringify(data).slice(0, 300));
            const t = data?.msg?.market_ticker ?? '';
            if (GAME_RE.test(t)) {
              gameMarketsDetected++;
              newMarkets.push(t);
              await checkNewGameMarket(t, data?.msg?.title ?? t);
              alertsFired++;
            }
          } catch {}
        };
        ws.onerror = (ev) => { errors.push((ev as any).message ?? 'ws error'); };
        ws.onclose = () => { clearTimeout(timeout); resolve(); };
      });
      await done;
    } catch (err) {
      errors.push('WS: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  const durationMs = Date.now() - startMs;
  console.log('[kalshiws-done]', JSON.stringify({
    durationMs, connected, messagesReceived,
    gameMarketsDetected, alertsFired, errors: errors.length,
    newMarkets,
  }));

  return new Response(JSON.stringify({
    ok: true, durationMs, connected, hasWSS, messagesReceived,
    gameMarketsDetected, alertsFired, newMarkets, errors,
  }), { headers: { 'Content-Type': 'application/json' } });
});
