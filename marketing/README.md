# Marketing artwork

## `quickserve-flyer.html` / `quickserve-flyer.png`

The QuickServe Cashloan social flyer, 1080 × 1350 (4:5 — the portrait size Instagram
and Facebook show largest). The PNG is rendered at 2× (2160 × 2700) so it stays sharp
when a phone re-compresses it.

The HTML is the **source**. It is completely self-contained — the fonts (Inter,
Poppins) are embedded as base64 and every graphic is inline SVG — so it renders
identically on any machine with no network and no font installs, and it will still
render years from now.

### Changing the phone number

Open `quickserve-flyer.html`, search for `CONTACT NUMBER`, and edit the one line
under it:

```html
<!-- ===== CONTACT NUMBER — edit this one line ===== -->
<div class="digits">+264 81 281 9840</div>
```

Nothing else depends on it.

### Re-rendering the PNG

Open the HTML in Chrome and screenshot it, or regenerate it properly:

```bash
cd tools
npm install        # first time only
npm run flyer
```

The renderer sets a 1080 × 1350 viewport at 2× device scale, waits for the embedded
fonts to load, and checks that no two blocks overlap before it writes the file — so a
text change that pushes an element into another one fails loudly instead of shipping a
broken flyer.

### Brand colours

| Use | Hex |
|---|---|
| Deep teal (headline ink, panel) | `#06302E` → `#0A5B54` |
| Brand green | `#12B84F` |
| Amber (the "30%" badge, CONTACT US pill) | `#F5A623` |
| WhatsApp green | `#25D366` |
| Cream background | `#F6F3ED` |

These match `brand-logo.svg` and `icon.svg` in the repository root.

---

## Before you print or post this

The flyer advertises **"30% interest"** with no period stated. In Namibia the 30%
ceiling for a short-term microloan is a **once-off** charge on the principal for the
whole loan — not a monthly rate — and NAMFISA treats anything above 30% as unlawful.
Advertising a bare "30% interest" is ambiguous enough to be a disclosure problem on its
own, and it also has to be read together with the fact that a service fee counts
**inside** that 30%, not on top of it.

See `documents/README.md` for the full compliance picture. Wording that states the
charge unambiguously — for example *"30% of the loan amount, charged once, repayable
within 30 days"* — is both safer and a stronger selling point, because it is a
genuinely competitive claim once a borrower understands it.

## `how-to-apply-video.mp4`

A 90-second vertical video (780 × 1688, 60 fps, MP4/H.264 with AAC music) that walks a
client through applying on quickserve.group on a phone. It covers the quote
slip, the four application sheets, documents, the customer copy and the
tracking page, with large on-screen captions and a tap marker. It plays
inline on WhatsApp, Facebook and Instagram.

It was recorded from a local copy of the site with clearly marked SAMPLE
documents (`how-to-apply/*-sample.jpg`), so no real application was made.

### Re-recording after the website changes

`how-to-apply/record.cjs` drives the site in a browser and records the
browser's own screen stream (about 45–60 frames a second while things move).
The page is shown at 2× zoom in a 780-wide window, so it keeps its phone
layout while every frame is sharp; the few sizes that depend on screen
width are pinned to what a 390-wide phone shows. `ffmpeg` then turns the
frames into a 60 fps video. It expects the website on
`http://localhost:8788` and the application service on
`http://localhost:8787`, both with the bot check off. Captions and timing are
in the script.

```bash
node marketing/how-to-apply/record.cjs
ffmpeg -f concat -safe 0 -i marketing/how-to-apply/frames.ffconcat \
  -vf "scale=780:1688:force_original_aspect_ratio=decrease,pad=780:1688:(ow-iw)/2:0:color=0x053437,setsar=1,fps=60,format=yuv420p" \
  -c:v libx264 -preset slow -crf 19 -movflags +faststart -an marketing/how-to-apply-video.mp4
```

### Music

The background tune is original: composed and synthesised by
`how-to-apply/music.py` (numpy only, no samples or third-party music), so it
can be posted anywhere without licensing worries. It's an upbeat
"explainer" style at 112 BPM with marimba-like plucks, pads, bass and light
drums, fading in and out. To rebuild the video with music:

```bash
python3 marketing/how-to-apply/music.py /tmp/music.wav 90.6
ffmpeg -i marketing/how-to-apply-video.mp4 -i /tmp/music.wav -map 0:v -map 1:a -c:v copy \
  -af "loudnorm=I=-18:TP=-1.5:LRA=9" -c:a aac -b:a 160k -shortest -movflags +faststart out.mp4
```

## `website-launch-poster.html` / `website-launch-poster.png`

The website launch poster, 1080 × 1350 (4:5), in the website's "No small
print" style: "We're online. Apply from your phone.", a launch slip with the
key terms and a QR code to https://quickserve.group, the four stamps, and the
contact number. The PNG is rendered at 2× (2160 × 2700).

Like the flyer, the HTML is the source and is self-contained (fonts and QR
code embedded). Edit it, then re-render; the renderer also checks that no
two blocks overlap:

```bash
cd tools
npm install        # first time only
npm run poster
```

## `website-launch-status.html` / `website-launch-status.png`

The same launch poster for WhatsApp Status and Instagram/Facebook Stories,
1080 × 1920 (9:16; PNG at 2×). WhatsApp's own bars cover roughly the top
140 px and the bottom 160 px, so the headline, slip, QR code and phone
number sit clear of them; the legal line runs along the bottom strip.
`npm run poster` renders both sizes.

## `website-coming-soon-poster.html` / `website-coming-soon-status.html`

Teaser posters announcing that the website is launching soon, in the same
style as the launch posters: "Going online. Apply from your phone." with a
COMING SOON stamp, and a QR code that opens quickserve.group on launch day.
1080×1350 for feeds and 1080×1920 for WhatsApp Status. To add a launch date,
change the stamp's `<small>WATCH THIS SPACE</small>` line. Re-render with
`cd tools && npm run poster:soon` (it also checks nothing overlaps).
