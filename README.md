# Map Diff

A cross-browser extension that adds map-specific win rate and pick rate analysis to the [Overwatch Hero Statistics](https://overwatch.blizzard.com/en-us/rates/) page. Works with both Chrome and Firefox.

Select a specific map and Map Diff computes the difference between each hero's stats on that map vs their all-maps average — so you can instantly see who over- or under-performs. It adds diff badges to the table, a map analysis panel with trait breakdowns and ban suggestions, per-hero best/worst maps, and sortable diff columns. Everything is toggleable from the settings popup.

## Installation (Sideloading)

Because webstores take a while to get approval, you might want to sideload this to test it out. I definitely don't recommend making a habit of this sort of thing, but the code is all here and you're welcome to ask your favourite chatbot (or developer freind, but trust me, they're using the chatbot) if theres anything sussy about it.

### Chrome

1. **Download the extension**

   Clone this repo or click **Code > Download ZIP** on GitHub and extract it somewhere you won't accidentally delete:
   ```bash
   git clone https://github.com/AndKenneth/mapdiff.git
   ```

2. **Open the extensions page**

   In Chrome, navigate to `chrome://extensions` (type it into the address bar).

3. **Enable Developer Mode**

   In the top-right corner of the extensions page, toggle **Developer mode** on.

4. **Load the extension**

   Click the **Load unpacked** button that appears in the top-left. In the file picker, select the `mapdiff` folder (the one that contains `manifest.json`).

### Firefox

1. **Download the extension**

   Clone this repo or click **Code > Download ZIP** on GitHub and extract it somewhere you won't accidentally delete:
   ```bash
   git clone https://github.com/AndKenneth/mapdiff.git
   ```

2. **Open the Add-ons page**

   In Firefox, navigate to `about:debugging#/runtime/this-firefox` (type it into the address bar).

3. **Load the extension**

   Click the **Load Temporary Add-on** button. In the file picker, select the `manifest.json` file inside the `mapdiff` folder.

   > **Note:** Temporary add-ons are removed when Firefox restarts. For permanent installation, you would need to sign the extension, which requires Mozilla account setup.

Map Diff runs entirely in your browser and only on the overwatch stats website. It reads hero data from the page, fetches the all-maps baseline, computes diffs, and injects the UI. 

## Permissions

- **`storage`** — save your preferences
- **`https://overwatch.blizzard.com/*`** — fetch hero statistics data

## Privacy

No data collection, tracking, or third-party services. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## License

MIT
