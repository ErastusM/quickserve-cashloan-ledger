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

An 89-second vertical video (780 × 1688, MP4/H.264, no sound) that walks a
client through applying on quickserve.group on a phone. It covers the quote
slip, the four application sheets, documents, the customer copy and the
tracking page, with large on-screen captions and a tap marker. It plays
inline on WhatsApp, Facebook and Instagram.

It was recorded from a local copy of the site with clearly marked SAMPLE
documents (`how-to-apply/*-sample.jpg`), so no real application was made.

### Re-recording after the website changes

`how-to-apply/record.cjs` drives a phone-sized browser and saves a frame
about every 0.1 s, then `ffmpeg` joins them. It expects the website on
`http://localhost:8788` and the application service on
`http://localhost:8787`, both with the bot check off. Captions and timing are
in the script.

```bash
node marketing/how-to-apply/record.cjs
ffmpeg -f concat -safe 0 -i marketing/how-to-apply/frames.ffconcat \
  -vf "scale=780:1688:force_original_aspect_ratio=decrease,pad=780:1688:(ow-iw)/2:0:color=0x053437,setsar=1,fps=30,format=yuv420p" \
  -c:v libx264 -preset slow -crf 20 -movflags +faststart -an marketing/how-to-apply-video.mp4
```
