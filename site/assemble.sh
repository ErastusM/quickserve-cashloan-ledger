#!/bin/sh
# Builds the published site into _site/: the admin console only. The phone
# app, apply form, old inbox and documents stay in the repository but are not
# published. The console is served at the site root and at /admin/ so older
# links keep working; 404.html and sw.js (which retires the phone app's
# offline cache) come from site/. Each build is stamped with its date and
# commit so the console can tell when a newer copy is online.
set -eu
rm -rf _site
mkdir -p _site/admin
cp admin/index.html _site/index.html
cp admin/index.html _site/admin/index.html
cp site/404.html site/sw.js _site/
BUILD="$(date -u +%Y-%m-%d)-$(git rev-parse --short HEAD 2>/dev/null || echo local)"
for f in _site/index.html _site/admin/index.html; do
  sed -i "s|<meta name=\"qs-build\" content=\"dev\" />|<meta name=\"qs-build\" content=\"$BUILD\" />|" "$f"
  grep -q "content=\"$BUILD\"" "$f"
done
echo "build $BUILD"
