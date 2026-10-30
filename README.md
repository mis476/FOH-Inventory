# FOH Inventory (Whimsiland FOH Stock)

Cafe + Barista crockery stock ka Google Apps Script web app.
Code yahan GitHub pe rehta hai. Deploy `clasp` se hota hai, copy-paste ki zaroorat nahi.

## Ek baar ka setup (MIS ke PC pe)

1. Node.js install ho (https://nodejs.org). Phir clasp install karo aur login karo (mis@whimsilandindia.com):

   ```bash
   npm install -g @google/clasp
   ```

   ```bash
   clasp login
   ```

2. Apps Script API on karo: https://script.google.com/home/usersettings → "Google Apps Script API" = On.

3. Repo clone karo:

   ```bash
   git clone https://github.com/mis476/FOH-Inventory.git
   ```

   ```bash
   cd FOH-Inventory
   ```

4. Apps Script se current code utaaro (Code.js, Index.html, appsscript.json `src/` mein aa jayenge):

   ```bash
   npm run pull
   ```

5. GitHub pe daalo:

   ```bash
   git add -A
   ```

   ```bash
   git commit -m "FOH Stock: code from Apps Script"
   ```

   ```bash
   git push
   ```

## Roz ka kaam

Claude Code code badalta hai aur GitHub pe push karta hai. Live karne ke liye PC pe sirf:

```bash
npm run live
```

Ye `git pull`, syntax check, `clasp push`, phir `clasp deploy -i <same deployment>` karta hai,
to staff ka web app link wahi rehta hai, bas naya version aa jata hai.
Pehli baar deployment ID `clasp deployments` se dhoondh ke `.deployment-id` mein save hoti hai
(ye file git mein nahi jaati).

| Command | Kaam |
|-|-|
| `npm run pull` | Apps Script editor ka code `src/` mein laao (sirf tab jab editor mein seedha change kiya ho) |
| `npm run check` | Syntax check |
| `npm run push` | Check + `clasp push` (sirf HEAD / test deployment update hota hai) |
| `npm run live` | Pull + check + push + deploy (staff link pe naya version) |

**Dhyan rahe:** ab Apps Script editor mein seedha edit mat karna. Kiya ho to pehle `npm run pull`
karke commit aur push karo, warna agla `npm run live` us change ko overwrite kar dega.

## Files

| File | Kaam |
|-|-|
| `src/Code.js` | Server: getInitData, getStock, saveEntries, voidEntry, getSummary, sheet menu, setup, health check |
| `src/Index.html` | Web app (Stock & entry, Summary, Entries) |
| `src/appsscript.json` | Manifest (timeZone Asia/Kolkata, webapp settings) |
| `.clasp.json` | Script ID + rootDir `src` |
| `tools/live.js` | `npm run live` |
| `tests/check.js` | `npm run check` |
