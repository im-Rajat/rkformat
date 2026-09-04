/**
 * Service worker for the .rkf editor.
 *
 * Two jobs, both in service of "share the file, not a link":
 *
 *  1. The editor works offline after one visit. Someone who is sent a .rkf can open it on a
 *     plane; nothing here talks to a server anyway, so there is no reason to need the network.
 *  2. It makes the app installable, which is what lets the browser claim the `.rkf` extension
 *     via the manifest's `file_handlers` - the only standards-based way to make double-clicking
 *     a .rkf open it in a browser. A browser picks its handler from the extension, so no
 *     amount of cleverness inside the file can achieve that on its own.
 *
 * Cache-first, because the shell is static. The cache name below is a digest of the files in
 * SHELL, written by docs/build.py - do not edit it by hand. Deriving it means any change to a
 * cached file renames the cache, and the old one is deleted on activate, so a deploy cannot
 * leave visitors running yesterday's code. A constant maintained by hand would eventually be
 * forgotten, and the symptom (stale app, only for people who installed it) is hard to spot.
 */

"use strict";

const CACHE = "rkf-shell-0316fd253ce9";

// Relative so this works from a project page such as /rkformat/ as well as a root domain.
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "assets/document.css",
  "assets/highlight.css",
  "assets/viewer.css",
  "assets/rkf.js",
  "assets/rkfwrite.js",
  "assets/sanitize.js",
  "assets/markdown.js",
  "assets/tomarkdown.js",
  "assets/highlight.js",
  "assets/toolbar.js",
  "assets/app.js",
  "assets/share-template.html",
  "assets/icons/rkf-192.png",
  "assets/icons/rkf-512.png",
  "welcome.rkf",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Added one at a time: addAll rejects the whole install if any single request fails,
      // and one missing optional file should not leave the app uninstallable.
      await Promise.all(
        SHELL.map(async (path) => {
          try {
            await cache.add(new Request(path, { cache: "reload" }));
          } catch (error) {
            /* skip what is not there */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch a document fetched by ?url=

  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: request.mode === "navigate" });
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        // Offline and not cached: a navigation still gets the app shell.
        if (request.mode === "navigate") {
          const shell = await caches.match("index.html");
          if (shell) return shell;
        }
        throw error;
      }
    })()
  );
});
