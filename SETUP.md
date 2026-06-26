# QuickServe Cashloan Ledger — Setup

This is a local-only mobile web app. It stores all data in the phone's browser. There is no server and nothing is uploaded.

## Install on your phone (recommended)

1. Open the live app on the phone browser:
   https://erastusm.github.io/quickserve-cashloan-ledger/
2. Open the browser menu and choose **Add to Home screen** (Safari) or **Install app** (Chrome).
3. Launch it from the home-screen icon. It works offline after the first open.

## Load your loan book

The hosted app starts empty (no client data is published). To bring your data in:

1. On a device that already has your data, open **Reports > Backup** to save a `.json` file.
2. On the new device, open **Reports > Restore** and pick that `.json` file.

## Set a PIN (optional but recommended)

Go to **Reports > Security > Set PIN**. After that, the app asks for the PIN each time it opens. You can change or remove it from the same place.

## Backup habit

The data lives only in this phone's browser. Use **Reports > Backup** regularly and keep the file somewhere safe (Google Drive, iCloud, OneDrive, or sent to yourself on WhatsApp).

If the phone is lost, reset, or its browser data is cleared, the backup file is what brings the loan book back.

## Run locally (for testing)

Serve the folder with any static server, for example:

```powershell
python -m http.server 8080
```

Then open `http://localhost:8080`, or from a phone on the same Wi-Fi use the computer's local IP, e.g. `http://192.168.8.121:8080`.
