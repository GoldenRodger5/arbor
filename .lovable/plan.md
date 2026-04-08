

# Arbor — Prediction Market Arbitrage Scanner

## Overview
A financial terminal-style PWA for scanning prediction market arbitrage opportunities across Kalshi and Polymarket. Dark theme, data-dense, no decorative elements.

## Design System
- Dark terminal palette: `#0A0A0F` base, `#111118` surface, `#1A1A24` elevated
- Inter + JetBrains Mono fonts, semantic colors (green=profit, red=loss, amber=caution, accent=action)
- Minimal border-radius (6px max), no shadows except elevated surfaces, ultra-thin scrollbars

## PWA Setup
- Manifest with standalone display, theme color `#0A0A0F`
- SVG-generated Venn diagram icon exported as 192px and 512px PNGs
- Apple mobile web app meta tags, no service worker (installable without offline support)

## Layout
- **Desktop (≥768px):** Fixed 220px left sidebar with text-only nav, status indicator, capital display. Content fills remaining width.
- **Mobile (<768px):** Bottom tab bar (60px + safe area), full-width scrollable content.

## Screens (5 routes)

### 1. Scanner
- Stats row: Kalshi Markets, Poly Markets, Matched Pairs counts
- Two-column table layout (stacked on mobile) showing markets from each platform
- Columns: Title, YES price, Volume, Closes, Status (MATCHED/UNMATCHED)
- 8 realistic mock rows per platform

### 2. Opportunities (primary screen)
- Full-width table with filter toggles (ALL/SAFE/CAUTION)
- Columns: #, Event, Poly YES, Kalshi NO, Raw Spread, Net Spread, Max $, Verdict, Scanned
- Expandable rows showing orderbook depth bars + external links
- Rows with >3% spread get accent left border
- 6 mock rows with mixed verdicts

### 3. Analytics
- 4 stat cards: Total P&L, Win Rate, Avg Spread, Deployed (with progress bar)
- P&L line chart (30 days, recharts)
- Opportunities by Category horizontal bar chart + Spread Distribution histogram
- Trade History table (10 mock rows)
- Time range toggle: 7D/30D/ALL

### 4. Positions
- Card-based layout for open positions (not table)
- Each card: event title, poly/kalshi legs, deployed amount, unrealized P&L, settlement countdown
- Empty state: single muted text line
- 3 mock open positions

### 5. Settings
- API Credentials: masked inputs with show/hide for Kalshi & Polymarket keys
- Scanner config: spread threshold slider, scan interval selector, auto-scan toggle
- Capital: starting capital input, safety reserve %, calculated active capital
- Alerts: Telegram bot token/chat ID, test alert button
- Danger zone: clear all logs button

## Components (built from scratch, no component libraries)
- Skeleton loading with shimmer animation for tables
- Pulse animation for live status dot
- Number transition animations for P&L values
- All tables, toggles, sliders, inputs built custom

## Tech
- React + TypeScript + Vite + React Router + Recharts + Tailwind (layout only)
- All colors/typography via CSS custom properties
- Mock data with realistic prediction market event names and values

