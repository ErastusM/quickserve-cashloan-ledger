#!/bin/sh
# Builds the published site into _site/: the admin console only. The phone
# app, apply form, old inbox and documents stay in the repository but are not
# published. The console is served at the site root and at /admin/ so older
# links keep working; 404.html and sw.js (which retires the phone app's
# offline cache) come from site/.
set -eu
rm -rf _site
mkdir -p _site/admin
cp admin/index.html _site/index.html
cp admin/index.html _site/admin/index.html
cp site/404.html site/sw.js _site/
