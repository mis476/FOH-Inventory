# FOH Inventory – project guide for Claude Code

Google Apps Script web app (sheet-bound) for Whimsiland FOH crockery stock, sections Cafe + Barista.
Script ID in `.clasp.json`; code in `src/` (clasp rootDir). App text English, owner chat Hinglish.

## Golden rule
Stock is NEVER stored as a running number. Opening / Closing / Summary are always calculated
(computeStock_) from ITEM_MASTER (Base Opening + Base Date) + TRANSACTIONS (ACTIVE rows only).

## Sheet tabs
ITEM_MASTER (input: items + base opening), TRANSACTIONS (ledger, rows never deleted – wrong entry = VOID with reason),
SUMMARY (B2:B4 filters, onEdit refresh), ACCESS (who can use the app), Employee_Master (only read by Setup to fill ACCESS).
STAFF, SETTINGS and STOCK_NOW are gone (Setup deletes them).

## Access (ACCESS sheet)
* Columns: Name | Email | Active | Section (Cafe/Barista/Both) | Stock/Summary/Entries Tab | Add | Breakage | Void | Personal Link.
* Login = Google account email. Company (@whimsilandindia.com) emails are detected directly. Gmail emails are hidden by
  Google (web app runs as owner), so they use a personal link `?k=<key>` (menu "Make personal links"; key → email in
  Script Properties K_/E_). Owner (mis@) always has full access.
* Every public api (getInitData, getStock, saveEntries, voidEntry, getSummary) takes the key as last arg and checks
  currentUser_ first. Menu functions call requireSheetUser_ (web app must not run them).
* Entered By / Void By = logged-in user's name.
* appsscript.json web app access = ANYONE (any Google account can open the link; ACCESS decides who gets in).

## Rules
* saveEntries is all-or-nothing, under ScriptLock, duplicate-safe via requestId; stock may never go negative.
* Types offered: ADD / BREAKAGE (CFG.ENTRY_TYPES). MISSING and ADJUST are legacy (old rows still counted, new ones rejected).
* Dates / IDs written as text ('yyyy-MM-dd') so there is no timezone mismatch. Keep appsscript.json timeZone Asia/Kolkata.
* Do not change sheet headers (HEAD) – ensureSheet_ throws if they differ.
* Browser gets only strings / numbers, never Date objects.

## How to work with me (the owner, "MIS")
1. Reply in Hinglish, simple words.
2. Explain the plan first and WAIT for "ok" before editing files.
3. Before saying "done": `npm run check` must pass.
4. Release only when I say "deploy" / "live karo": I run `npm run live` on my PC.
   Never `clasp deploy` without `-i`. Never `clasp pull` unless I ask.
