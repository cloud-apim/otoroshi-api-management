#!/bin/bash
# builds the documentation website into ./docs, for GitHub Pages
cd ./documentation
npm install
npm run build
cd ..
rm -rf ./docs
mv ./documentation/build ./docs
git add --all
git commit -am 'build documentation website'
git push origin main
