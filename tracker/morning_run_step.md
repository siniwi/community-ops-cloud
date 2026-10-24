## 7. Feedback tracker: Suggested tab (08:40 run only; added 2026-10-23)

Sort new player reports for the tracker's Suggested tab (https://aimlabs-dash.pages.dev/tracker/). Never post or send anything. Your only write in this step is one labels file to Drive. The team adds, +1s or dismisses each suggestion on the page; nothing reaches the tracker on its own.

1. Find tracker_intake_todo.json in the drops folder (search `parentId = '1MM6oSIGPGcBNGA_OyC703LRl_E7bIFy4' and title = 'tracker_intake_todo.json'`). Download it with download_file_content and decode it to ./tracker_intake_todo.json. GitHub Actions refreshes it hourly. It holds up to 150 unsorted Steam reviews, Reddit posts and Steam forum threads from the last 4 days. If `items` is empty, skip this step.
2. For each item, decide whether it reports a concrete bug, gives feedback on the product, or asks for a feature. Skip:
   - praise without specifics
   - insults and memes
   - questions asking for aim advice
   - posts about other games
   - Aimlabs team announcements
3. Write a JSON list with one object per item, in the same order:
   - Skipped: `{"sid": "...", "skip": true}`
   - Kept: `{"sid": "...", "kind": "Bug"|"Feedback"|"Request", "area": "...", "issue": "...", "en": "...", "sent": "positive"|"neutral"|"negative"}`
   - **issue**: at most 90 characters, in plain, neutral English. Describe the problem or the ask, not the player's tone. Example: "Steam login says username already in use". Use exactly the same wording for every item about the same issue in this run, so the page can group them.
   - **en**: a faithful English translation when the text isn't in English, otherwise "". Keep it short and drop pure swearing.
   - **Several issues in one post**: add one object per issue, with `"part": 2`, `3`, and so on. Give `en` only on the first part.
   - **Reddit or forum posts not in English**: also add `"lang"`, for example "schinese" or "russian".
   - **area**: one of Crashes & performance; Account & profile; Game profiles & sens; Controller; PvP & 1v1; Benchmarks & ranked; Leaderboards; Creator Studio; Training programs; Playlists & tasks; Results & replays; Audio; Settings & visuals; Gameplay & weapons; Social & chat; Coach & AI; Store & Aimlabs+; UI & navigation; Other.
4. Save the list to Drive with create_file:
   - parentId `1I6ZoJMLA0cr5G3Rtgh9vxXjYzbJrL0sg` (the tracker_ops folder)
   - title `labels-<YYYY-MM-DD-HHMM>.json`, in Hirad's local time
   - contentMimeType `application/json`, with disableConversionToGoogleType true
   - textContent: the compact JSON, with no indentation

   The next hourly Actions run, within the hour, turns the kept items into suggestions on the page.
5. In meta/status, add "Tracker: N sorted, K suggested". When `left_for_next_run` > 0, also add "+M left for next run". If anything fails, write "Tracker suggestions not sorted: <reason>" and carry on.

Cost: one pass over at most 150 short items. Don't read anything else for this step.
