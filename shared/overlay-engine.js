/* ════════════════════════════════════════════
   OVERLAY ENGINE — shared by all 4 thin clients
   (radio-overlay, vertical-radio-overlay,
    360-overlay, vertical-360-overlay)

   Each thin client sets window.OVERLAY_CONFIG
   BEFORE loading this file, e.g.:

     window.OVERLAY_CONFIG = {
       stationId:       's115121de1',
       albumsCsvUrl:    '...',
       concertsCsvUrl:  '...',
       debug:           false,
       debugTitle:      'RADIO OVERLAY — DIAGNOSTIC LOG (newest first)'
     };

   Everything below is orientation-agnostic and
   station-agnostic. Layout differences live in
   horizontal.css / vertical.css; station identity
   lives in each thin client's config block.

   Matching logic note: artist/album matching is
   fuzzy (substring match in either direction) and
   dates are parsed with a tolerant M/D/YY(YY) or
   M-D-YY(YY) parser. Concert display omits the
   state abbreviation for RI/MA/CT (home markets)
   but still uses the fuller set of state names for
   sorting priority.
════════════════════════════════════════════ */

(function () {
  'use strict';

  var cfg = window.OVERLAY_CONFIG || {};

  // ── CONFIG (with sensible defaults) ─────────────────────
  var STATION_ID        = cfg.stationId;
  var POLL_INTERVAL_MS  = cfg.pollIntervalMs   || 12000;
  var ALBUMS_CSV_URL    = cfg.albumsCsvUrl;
  var CONCERTS_CSV_URL  = cfg.concertsCsvUrl;
  var V2_MATCH_RETRIES  = cfg.v2MatchRetries   || 4;
  var V2_RETRY_DELAY_MS = cfg.v2RetryDelayMs   || 4000;
  var FADE_DURATION_MS  = cfg.fadeDurationMs   || 600;
  var DEBUG              = !!cfg.debug;
  var DEBUG_TITLE        = cfg.debugTitle || 'OVERLAY — DIAGNOSTIC LOG (newest first)';

  // ── SHOW-SCHEDULE / STALE-METADATA FALLBACK (optional) ──
  // Only active when scheduleCsvUrl is set in config. When metadata
  // hasn't refreshed in longer than the current track's duration (plus
  // a buffer), the engine shows the currently-scheduled show's name and
  // artwork instead of stale/wrong track info.
  var SCHEDULE_CSV_URL     = cfg.scheduleCsvUrl || null;
  var SCHEDULE_TIMEZONE    = cfg.scheduleTimezone   || 'America/New_York';
  var GITHUB_REPO          = cfg.githubRepo   || null; // e.g. 'pjlitrock/wbru-overlay' — required to resolve show artwork
  var GITHUB_BRANCH        = cfg.githubBranch || 'main';

  if (!STATION_ID) {
    console.error('OVERLAY_CONFIG.stationId is required — set it before loading overlay-engine.js');
    return;
  }

  var STATUS_URL   = 'https://public.radio.co/stations/' + STATION_ID + '/status';
  var TRACK_V2_URL = 'https://public.radio.co/api/v2/' + STATION_ID + '/track/current';

  var pendingTitle     = null;
  var confirmedTitle   = null;
  var v2RetryTimer     = null;
  var isVisible        = false;
  var upcomingAlbums   = [];
  var upcomingConcerts = [];
  var showSchedule     = [];
  var artworkUrlCache  = {}; // folderPath -> { url, resolvedAt } (GitHub API folder listing results)

  // Show-mode state
  var displayMode      = 'none'; // 'none' | 'track' | 'show' | 'blank'
  var currentShowKey   = null;

  // Cache of cleanly verified track metadata keyed by rawTitle.
  // Stores only short strings (artist, title, album, artwork URL) —
  // not image data — so memory growth is negligible even over long sessions.
  var metadataCache = {};

  function cacheSet(rawTitle, data) {
    metadataCache[rawTitle] = data;
  }

  // ── DOM REFS ─────────────────────────────────────────────
  var debugEl, debugTitleEl, debugLog;
  var metaSong, metaArtistRow, metaArtist, metaConcert;
  var metaAlbumRow, metaAlbum, metaRelease;
  var artImg, artPlaceholder, artworkBlock, metadataBlock;

  function grabDom() {
    debugEl        = document.getElementById('debug');
    debugTitleEl   = document.getElementById('debug-title');
    debugLog       = document.getElementById('debug-log');
    metaSong       = document.getElementById('meta-song');
    metaArtistRow  = document.getElementById('meta-artist-row');
    metaArtist     = document.getElementById('meta-artist');
    metaConcert    = document.getElementById('meta-concert');
    metaAlbumRow   = document.getElementById('meta-album-row');
    metaAlbum      = document.getElementById('meta-album');
    metaRelease    = document.getElementById('meta-release');
    artImg         = document.getElementById('artwork-img');
    artPlaceholder = document.getElementById('artwork-placeholder');
    artworkBlock   = document.getElementById('artwork-block');
    metadataBlock  = document.getElementById('metadata-block');

    if (debugTitleEl) debugTitleEl.textContent = DEBUG_TITLE;
    if (debugEl) debugEl.style.display = DEBUG ? 'block' : 'none';

    artworkBlock.style.opacity  = '0';
    metadataBlock.style.opacity = '0';
  }

  // ── LOGGING ─────────────────────────────────────────────
  function log(message, cssClass, dataStr) {
    if (!debugLog) return;
    var time = new Date().toLocaleTimeString();
    var el   = document.createElement('div');
    el.style.cssText = 'border-bottom:1px solid #1a1a1a;padding-bottom:3px;margin-bottom:3px;';
    el.innerHTML =
      '<span style="color:#555">[' + time + ']</span> ' +
      '<span class="' + (cssClass || '') + '">' + message + '</span>' +
      (dataStr ? '<div class="log-data">' + dataStr + '</div>' : '');
    debugLog.insertBefore(el, debugLog.firstChild);
    while (debugLog.children.length > 60) debugLog.removeChild(debugLog.lastChild);
  }

  // ── CSV PARSER ───────────────────────────────────────────
  // Handles quoted fields containing commas.
  function parseCSVRow(row) {
    var cols = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < row.length; i++) {
      var ch = row[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cols.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cols.push(current.trim());
    return cols;
  }

  // Tolerant date parser: handles trailing spaces, 2-digit and
  // 4-digit years, and '/' or '-' separators (M/D/YY, M-D-YYYY, etc).
  function parseFlexibleDate(dateStr) {
    if (!dateStr) return new Date(NaN);
    var clean = dateStr.trim();
    var m = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
    if (m) {
      clean = m[1] + '/' + m[2] + '/20' + m[3];
    }
    return new Date(clean);
  }

  // ── LOAD UPCOMING ALBUMS ─────────────────────────────────
  // Google Sheet columns: Release Date, Artist, Album
  function loadUpcomingAlbums() {
    return fetch(ALBUMS_CSV_URL, { cache: 'no-store' })
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function(text) {
        var rows   = text.trim().replace(/\r/g, '').split('\n');
        var parsed = [];
        for (var i = 0; i < rows.length; i++) {
          var cols = parseCSVRow(rows[i]);
          if (cols.length < 3) continue;
          var releaseDate = parseFlexibleDate(cols[0]);
          if (isNaN(releaseDate.getTime())) continue; // skip header
          parsed.push({ releaseDate: releaseDate, artist: cols[1], album: cols[2] });
        }
        upcomingAlbums = parsed;
        log('📀 Loaded ' + parsed.length + ' upcoming album(s) from Google Sheets', 'log-ok');
      })
      .catch(function(err) {
        log('⚠️ Albums sheet failed: ' + err.message, 'log-wait');
      });
  }

  // ── LOAD UPCOMING CONCERTS ───────────────────────────────
  // Google Sheet columns: Artist, Date, City, State, Venue, ...
  function loadUpcomingConcerts() {
    return fetch(CONCERTS_CSV_URL, { cache: 'no-store' })
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function(text) {
        var rows   = text.trim().replace(/\r/g, '').split('\n');
        var parsed = [];
        for (var i = 0; i < rows.length; i++) {
          var cols = parseCSVRow(rows[i]);
          if (cols.length < 5) continue;
          var rawDate     = cols[1];
          var concertDate = parseFlexibleDate(rawDate);
          if (isNaN(concertDate.getTime())) {
            // Log rows with digits that failed to parse (not just header)
            if (rawDate.match(/\d/)) log('⚠️ Concert date parse failed: "' + rawDate + '" in: ' + rows[i].slice(0,60), 'log-wait');
            continue;
          }
          parsed.push({
            artist:      cols[0],
            concertDate: concertDate,
            city:        cols[2],
            state:       cols[3],
            venue:       cols[4]
          });
        }
        upcomingConcerts = parsed;
        log('🎤 Loaded ' + parsed.length + ' upcoming concert(s) from Google Sheets', 'log-ok');
      })
      .catch(function(err) {
        log('⚠️ Concerts sheet failed: ' + err.message, 'log-wait');
      });
  }

  // ── FUZZY ARTIST MATCH ──────────────────────────────────
  // Exact match, or substring match in either direction —
  // handles featured artists / minor name variations.
  function artistMatches(rowArtist, cleanArtist) {
    var a = (rowArtist || '').toLowerCase().trim();
    return a === cleanArtist ||
           cleanArtist.indexOf(a) !== -1 ||
           a.indexOf(cleanArtist) !== -1;
  }

  // ── LOOKUP: UPCOMING ALBUM RELEASE ──────────────────────
  function checkUpcomingAlbum(artist, album) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var cleanArtist = (artist || '').toLowerCase().trim();
    var cleanAlbum  = (album  || '').toLowerCase().trim();

    for (var i = 0; i < upcomingAlbums.length; i++) {
      var row = upcomingAlbums[i];
      var rowArtist = (row.artist || '').toLowerCase().trim();
      var artistMatch = artistMatches(rowArtist, cleanArtist) || rowArtist === 'various artists';

      if (artistMatch &&
          (row.album || '').toLowerCase().trim() === cleanAlbum &&
          row.releaseDate > today) {
        return 'out ' + row.releaseDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
    }
    return null;
  }

  // ── LOOKUP: NEAREST UPCOMING CONCERT ───────────────────
  // Sorts by proximity to Providence first (RI > MA > CT > other),
  // then by date within each tier. This ensures a later RI show
  // always displays before an earlier CT show.
  function statePriority(state) {
    var s = (state || '').trim().toUpperCase();
    if (s === 'RI' || s === 'RHODE ISLAND')  return 0;
    if (s === 'MA' || s === 'MASSACHUSETTS') return 1;
    if (s === 'CT' || s === 'CONNECTICUT')   return 2;
    return 3;
  }

  function checkUpcomingConcert(artist) {
    if (!artist) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var cleanArtist = artist.toLowerCase().trim();
    var matches = [];

    for (var i = 0; i < upcomingConcerts.length; i++) {
      var row = upcomingConcerts[i];
      if (artistMatches(row.artist, cleanArtist) && row.concertDate >= today) {
        matches.push(row);
      }
    }
    if (!matches.length) return null;

    matches.sort(function(a, b) {
      var pa = statePriority(a.state);
      var pb = statePriority(b.state);
      if (pa !== pb) return pa - pb;            // closer state first
      return a.concertDate - b.concertDate;     // earlier date within same state
    });

    var next    = matches[0];
    var dateStr = next.concertDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    // Omit state for RI, MA, and CT — audience knows these markets
    var isLocal = statePriority(next.state) <= 2;
    var location = isLocal ? next.city : next.city + ', ' + (next.state || '').trim().toUpperCase();
    return dateStr + ' @ ' + next.venue + ' - ' + location;
  }

  // ── LOAD SHOW SCHEDULE ───────────────────────────────────
  // Google Sheet columns: Day, Start_Time, End_Time, Show, Artwork_Link
  // Day is a weekday name, "Daily" (matches every day), or "Default"
  // (catch-all fallback, blank Start_Time/End_Time, always matches).
  function loadShowSchedule() {
    if (!SCHEDULE_CSV_URL) return Promise.resolve();
    return fetch(SCHEDULE_CSV_URL, { cache: 'no-store' })
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function(text) {
        var rows   = text.trim().replace(/\r/g, '').split('\n');
        var parsed = [];
        for (var i = 0; i < rows.length; i++) {
          var cols = parseCSVRow(rows[i]);
          if (cols.length < 4) continue;
          var day = (cols[0] || '').trim();
          if (!day || day.toLowerCase() === 'day') continue; // skip blank/header row
          var startStr = (cols[1] || '').trim();
          var endStr   = (cols[2] || '').trim();
          parsed.push({
            day:           day,
            startMin:      startStr ? parseTimeToMinutes(startStr) : null,
            endMin:        endStr   ? parseTimeToMinutes(endStr)   : null,
            show:          (cols[3] || '').trim(),
            artworkFolder: (cols[4] || '').trim()
          });
        }
        showSchedule = parsed;
        log('📅 Loaded ' + parsed.length + ' show schedule entrie(s)', 'log-ok');
      })
      .catch(function(err) {
        log('⚠️ Show schedule failed: ' + err.message, 'log-wait');
      });
  }

  // Parses "12:00 PM" / "1:05 AM" style strings into minutes-since-midnight.
  function parseTimeToMinutes(str) {
    var m = str.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
    if (!m) return null;
    var h  = parseInt(m[1], 10);
    var mi = parseInt(m[2], 10);
    var ap = m[3].toUpperCase();
    if (ap === 'AM') { if (h === 12) h = 0; }
    else             { if (h !== 12) h += 12; }
    return h * 60 + mi;
  }

  // Current weekday name + minutes-since-midnight, in the schedule's timezone
  // (not the machine's local timezone — important since OBS may run on a
  // machine set to a different zone than the station's market).
  function nowInScheduleTZ() {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: SCHEDULE_TIMEZONE, weekday: 'long',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    var weekday, hour, minute;
    fmt.formatToParts(new Date()).forEach(function(p) {
      if (p.type === 'weekday') weekday = p.value;
      if (p.type === 'hour')    hour    = parseInt(p.value, 10);
      if (p.type === 'minute')  minute  = parseInt(p.value, 10);
    });
    if (hour === 24) hour = 0; // some browsers report midnight as 24 with hour12:false
    return { weekday: weekday, minutes: hour * 60 + minute };
  }

  function timeInRange(nowMin, startMin, endMin) {
    if (startMin === null || endMin === null || startMin === endMin) return false;
    if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
    return nowMin >= startMin || nowMin < endMin; // crosses midnight
  }

  // Returns the currently-scheduled show ({show, artworkFolder, ...}), or
  // null if none. Priority: exact weekday match > "Daily" match > "Default".
  function getCurrentShow() {
    if (!showSchedule.length) return null;
    var now = nowInScheduleTZ();
    var exactMatch = null, dailyMatch = null, defaultRow = null;
    for (var i = 0; i < showSchedule.length; i++) {
      var row = showSchedule[i];
      var d   = row.day.toLowerCase();
      if (d === 'default') { if (!defaultRow) defaultRow = row; continue; }
      if (timeInRange(now.minutes, row.startMin, row.endMin)) {
        if (d === now.weekday.toLowerCase()) { if (!exactMatch) exactMatch = row; }
        else if (d === 'daily')              { if (!dailyMatch) dailyMatch = row; }
      }
    }
    return exactMatch || dailyMatch || defaultRow;
  }

  // Resolves a show's artwork folder to an actual image URL by asking
  // GitHub's API what's in the folder — this is what lets each folder
  // hold an image with ANY filename (no fixed "cover.jpg" convention),
  // so the filename itself can stay meaningful (date, source, notes).
  // Results are cached briefly per folder to avoid re-listing on every
  // stale check while a show is airing.
  var ARTWORK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — long enough to avoid repeat calls per show, short enough to pick up a swap without a page reload

  function resolveShowArtworkUrl(folderPath, onSuccess, onFail) {
    if (!folderPath) { onFail(); return; }
    if (!GITHUB_REPO) {
      log('⚠️ No githubRepo configured — cannot resolve show artwork folder', 'log-wait');
      onFail();
      return;
    }

    var cached = artworkUrlCache[folderPath];
    if (cached && (Date.now() - cached.resolvedAt) < ARTWORK_CACHE_TTL_MS) {
      if (cached.url) onSuccess(cached.url); else onFail();
      return;
    }

    var apiUrl = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' +
                 folderPath.replace(/^\/|\/$/g, '').split('/').map(encodeURIComponent).join('/') +
                 '?ref=' + encodeURIComponent(GITHUB_BRANCH);

    fetch(apiUrl, { cache: 'no-store' })
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(items) {
        var images = (Array.isArray(items) ? items : [])
          .filter(function(item) { return item.type === 'file' && /\.(jpe?g|png)$/i.test(item.name); })
          .sort(function(a, b) { return a.name.localeCompare(b.name); });

        if (!images.length) {
          log('⚠️ No .jpg/.png/.jpeg file found in ' + folderPath, 'log-wait');
          artworkUrlCache[folderPath] = { url: null, resolvedAt: Date.now() };
          onFail();
          return;
        }
        if (images.length > 1) {
          log('⚠️ ' + images.length + ' image files in ' + folderPath + ' — using "' + images[0].name + '" (keep just one to avoid ambiguity)', 'log-wait');
        }
        var url = images[0].download_url;
        artworkUrlCache[folderPath] = { url: url, resolvedAt: Date.now() };
        onSuccess(url);
      })
      .catch(function(err) {
        log('⚠️ Could not list ' + folderPath + ': ' + err.message, 'log-wait');
        onFail();
      });
  }

  // Shows the currently-scheduled show's name/artwork whenever track
  // metadata isn't the thing on screen — covers the hold-and-verify gap
  // between songs, drift-recovery gaps, and genuine dead air alike.
  // No-op entirely unless scheduleCsvUrl is configured.
  function fillGapIfNeeded() {
    if (!SCHEDULE_CSV_URL) return;

    var trackShowing = (displayMode === 'track' && isVisible);
    if (trackShowing) return;

    var show = getCurrentShow();
    if (show) {
      var showKey = show.day + '|' + show.startMin + '|' + show.show;
      if (displayMode !== 'show' || showKey !== currentShowKey) {
        currentShowKey = showKey;
        displayMode    = 'show';
        log('📻 No song info on screen — showing schedule: ' + show.show, 'log-wait');
        fadeInShow(show.show, show.artworkFolder);
      }
    } else if (displayMode !== 'blank' && displayMode !== 'none') {
      displayMode = 'blank';
      currentShowKey = null;
      log('📻 No song info and no show scheduled — fading out', 'log-wait');
      fadeOut();
    }
  }

  // ── TRANSITIONS ──────────────────────────────────────────
  function fadeOut() {
    return new Promise(function(resolve) {
      if (!isVisible) { resolve(); return; }
      artworkBlock.style.opacity  = '0';
      metadataBlock.style.opacity = '0';
      isVisible = false;
      log('⬇️ Fading out', 'log-wait');
      setTimeout(resolve, FADE_DURATION_MS);
    });
  }

  function fadeIn(artist, trackTitle, album, artworkUrl, releaseLabel, concertLabel) {
    // Always fade out whatever's currently on screen first (track or show
    // info) so this never looks like an abrupt jump-cut — a no-op wait if
    // nothing is currently visible.
    fadeOut().then(function() {
      displayMode      = 'track';
      currentShowKey   = null;
      metaArtistRow.style.display = 'flex'; // in case show mode hid it
      metaSong.textContent   = trackTitle;
      metaArtist.textContent = artist;

      if (concertLabel) {
        metaConcert.textContent   = concertLabel;
        metaConcert.style.display = 'inline';
      } else {
        metaConcert.textContent   = '';
        metaConcert.style.display = 'none';
      }

      if (album) {
        metaAlbum.textContent      = album;
        metaAlbumRow.style.display = 'flex';
        if (releaseLabel) {
          metaRelease.textContent   = releaseLabel;
          metaRelease.style.display = 'inline';
        } else {
          metaRelease.textContent   = '';
          metaRelease.style.display = 'none';
        }
      } else {
        metaAlbum.textContent      = '';
        metaRelease.textContent    = '';
        metaRelease.style.display  = 'none';
        metaAlbumRow.style.display = 'none';
      }

      if (artworkUrl) {
        var tmp    = new Image();
        tmp.onload = function() {
          artImg.src                   = artworkUrl;
          artPlaceholder.style.display = 'none';
          artImg.style.display         = 'block';
          artworkBlock.style.opacity   = '1';
          metadataBlock.style.opacity  = '1';
          isVisible = true;
          log('✅ Faded in: ' + artist + ' — ' + trackTitle, 'log-ok');
        };
        tmp.onerror = function() {
          artImg.style.display         = 'none';
          artPlaceholder.style.display = 'flex';
          artworkBlock.style.opacity   = '1';
          metadataBlock.style.opacity  = '1';
          isVisible = true;
          log('❌ Artwork failed, text only: ' + artworkUrl, 'log-fail');
        };
        tmp.src = artworkUrl;
      } else {
        artImg.style.display         = 'none';
        artPlaceholder.style.display = 'flex';
        artworkBlock.style.opacity   = '1';
        metadataBlock.style.opacity  = '1';
        isVisible = true;
      }
    });
  }

  // Displays a scheduled show's name/artwork in place of track metadata.
  // Only the song line is used; artist/concert/album/release rows are hidden.
  // Always fades out whatever's currently on screen first (a no-op wait if
  // nothing is currently visible), same guarantee as fadeIn().
  function fadeInShow(showName, artworkFolder) {
    fadeOut().then(function() {
      metaSong.textContent        = showName;
      metaArtist.textContent      = '';
      metaArtistRow.style.display = 'none';
      metaAlbumRow.style.display  = 'none';

      function showPlaceholder() {
        artImg.style.display         = 'none';
        artPlaceholder.style.display = 'flex';
        artworkBlock.style.opacity   = '1';
        metadataBlock.style.opacity  = '1';
        isVisible = true;
        log('📻 Show mode (no artwork found): ' + showName, 'log-ok');
      }

      if (!artworkFolder) { showPlaceholder(); return; }

      resolveShowArtworkUrl(artworkFolder, function(url) {
        artImg.src                   = url;
        artPlaceholder.style.display = 'none';
        artImg.style.display         = 'block';
        artworkBlock.style.opacity   = '1';
        metadataBlock.style.opacity  = '1';
        isVisible = true;
        log('📻 Show mode: ' + showName + ' (' + url + ')', 'log-ok');
      }, showPlaceholder);
    });
  }

  // ── APPLY VERIFIED METADATA ──────────────────────────────
  function applyMetadata(t) {
    var artist     = t.track_artist || '';
    var trackTitle = t.track_title  || '';
    var album      = t.track_album  || '';
    var artworkUrl = (t.artwork_urls && (t.artwork_urls.large || t.artwork_urls.standard)) || '';
    var release    = album  ? checkUpcomingAlbum(artist, album) : null;
    var concert    = artist ? checkUpcomingConcert(artist)      : null;

    // Cache this clean result so drift recovery can use it later
    if (confirmedTitle) {
      cacheSet(confirmedTitle, {
        artist: artist, trackTitle: trackTitle,
        album: album, artworkUrl: artworkUrl
      });
    }

    log('✅ Verified: ' + artist + ' / ' + trackTitle + ' / ' + album, 'log-ok');

    // ── CONCERT LOOKUP DIAGNOSTIC ────────────────────────
    if (!artist) {
      log('  🎤 Concert check: no artist name available', 'log-wait');
    } else {
      var today = new Date(); today.setHours(0,0,0,0);
      var cleanArtist = artist.toLowerCase().trim();
      var allForArtist = upcomingConcerts.filter(function(r) {
        return artistMatches(r.artist, cleanArtist);
      });
      var futureForArtist = allForArtist.filter(function(r) {
        return r.concertDate >= today;
      });
      if (allForArtist.length === 0) {
        log('  🎤 Concert: no entries for "' + artist + '"', 'log-wait');
      } else if (futureForArtist.length === 0) {
        log('  🎤 Concert: ' + allForArtist.length + ' entry/entries for "' + artist + '" but all past', 'log-wait');
      } else {
        // Show which concert won and all candidates for transparency
        var candidates = futureForArtist.map(function(r) {
          return r.concertDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                 + ' ' + r.city + ', ' + r.state;
        }).join(' | ');
        log('  🎤 Concert: ' + futureForArtist.length + ' upcoming → displaying: ' + concert, 'log-ok');
        log('  🎤 All candidates: ' + candidates, 'log-wait');
      }
    }

    // ── ALBUM LOOKUP DIAGNOSTIC ──────────────────────────
    if (!album) {
      log('  📀 Album check: no album title in metadata', 'log-wait');
    } else {
      var today2 = new Date(); today2.setHours(0,0,0,0);
      var cleanArtist2 = artist.toLowerCase().trim();
      var cleanAlbum2  = album.toLowerCase().trim();
      var allForAlbum = upcomingAlbums.filter(function(r) {
        var rArtist = (r.artist || '').toLowerCase().trim();
        var artistMatch = artistMatches(rArtist, cleanArtist2) || rArtist === 'various artists';
        return artistMatch && (r.album || '').toLowerCase().trim() === cleanAlbum2;
      });
      var futureForAlbum = allForAlbum.filter(function(r) {
        return r.releaseDate > today2;
      });
      if (allForAlbum.length === 0) {
        log('  📀 Album: "' + album + '" by "' + artist + '" not in list', 'log-wait');
      } else if (futureForAlbum.length === 0) {
        log('  📀 Album: "' + album + '" found but release date has passed', 'log-wait');
      } else {
        log('  📀 Album: match found → ' + release, 'log-ok');
      }
    }

    fadeIn(artist, trackTitle, album, artworkUrl, release, concert);
  }

  // ── V2 FETCH WITH DRIFT DETECTION & RECOVERY ───────────
  // radio.co sometimes updates track_album and artwork_urls to the
  // next track mid-song. We detect this by checking that track_artist
  // from v2 appears in the expected raw title. If it doesn't, v2 has
  // drifted. Rather than retrying (which won't help — v2 will keep
  // returning next-track data until the song ends), we recover by:
  //   1. Using the correct artist/title from v2 (these stay accurate)
  //   2. Looking up cached album/artwork from the last clean display
  //      of this same track, if we've seen it before
  //   3. If no cache hit, showing artist/title only with no album or
  //      artwork — wrong info is worse than no info
  function fetchAndVerifyV2(expectedRawTitle, attempt) {
    if (v2RetryTimer) { clearTimeout(v2RetryTimer); v2RetryTimer = null; }

    fetch(TRACK_V2_URL, { cache: 'no-store' })
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(json) {
        if (expectedRawTitle !== confirmedTitle) {
          log('⚠️ Track changed during retry — aborting', 'log-wait');
          return;
        }
        var t        = json.data;
        var v2Title  = (t && t.title)        || '';
        var v2Artist = (t && t.track_artist) || '';

        var titleMatch  = (v2Title === expectedRawTitle);
        var artistMatch = v2Artist &&
                          expectedRawTitle.toLowerCase().indexOf(v2Artist.toLowerCase()) !== -1;

        // Duration check: if v2 reports a track shorter than 30 seconds,
        // it has almost certainly jumped ahead to a station ID or jingle.
        // track_duration is in milliseconds.
        var duration       = (t && t.track_duration) || 999999;
        var durationOk     = duration >= 30000;

        var fullMatch   = titleMatch && artistMatch && durationOk;

        log('v2: "' + v2Title + '" artist: "' + v2Artist + '" duration: ' + Math.round(duration/1000) + 's | ' +
            (fullMatch ? '✓ clean' : 'DRIFT DETECTED title=' + titleMatch + ' artist=' + artistMatch + ' duration=' + durationOk),
            fullMatch ? 'log-ok' : 'log-retry');

        if (fullMatch) {
          // Clean data — cache it and display
          cacheSet(expectedRawTitle, {
            artist:     t.track_artist || '',
            trackTitle: t.track_title  || '',
            album:      t.track_album  || '',
            artworkUrl: (t.artwork_urls && (t.artwork_urls.large || t.artwork_urls.standard)) || ''
          });
          applyMetadata(t);
        } else if (titleMatch && (!artistMatch || !durationOk)) {
          // Title matches but artist or duration signals drift —
          // v2 album/artwork have crept ahead to the next item.
          // Retrying won't help. Recover using cache or show partial info.
          var cached = metadataCache[expectedRawTitle];
          if (cached) {
            log('↩️ Drift recovered from cache: ' + expectedRawTitle, 'log-ok');
            applyMetadataFromCache(cached);
          } else {
            // No cache — show artist/title only, no album or artwork
            log('⚠️ Drift with no cache — showing title/artist only', 'log-wait');
            applyMetadataPartial(expectedRawTitle, t);
          }
        } else if (attempt < V2_MATCH_RETRIES) {
          // Title itself doesn't match yet — v2 may just be behind. Retry.
          log('↩️ Title mismatch (attempt ' + attempt + '/' + V2_MATCH_RETRIES + ') — retry in ' + (V2_RETRY_DELAY_MS/1000) + 's', 'log-retry');
          v2RetryTimer = setTimeout(function() {
            fetchAndVerifyV2(expectedRawTitle, attempt + 1);
          }, V2_RETRY_DELAY_MS);
        } else {
          log('⚠️ Still mismatched after ' + V2_MATCH_RETRIES + ' attempts — best available', 'log-fail');
          applyMetadata(t);
        }
      })
      .catch(function(err) {
        log('❌ v2 fetch failed: ' + err.message, 'log-fail');
      });
  }

  // Display using cleanly cached metadata
  function applyMetadataFromCache(cached) {
    var release = cached.album ? checkUpcomingAlbum(cached.artist, cached.album) : null;
    var concert = cached.artist ? checkUpcomingConcert(cached.artist) : null;
    log('✅ Displaying from cache: ' + cached.artist + ' / ' + cached.trackTitle + ' / ' + cached.album, 'log-ok');
    fadeIn(cached.artist, cached.trackTitle, cached.album, cached.artworkUrl, release, concert);
  }

  // Display with artist/title only — no album or artwork
  // Used when v2 has drifted and we have no cached clean data
  function applyMetadataPartial(rawTitle, t) {
    // Use v2's track_artist if it matches, else parse from raw title
    var artist     = '';
    var trackTitle = '';
    var idx = rawTitle.indexOf(' - ');
    if (idx !== -1) {
      artist     = rawTitle.slice(0, idx).trim();
      trackTitle = rawTitle.slice(idx + 3).trim();
    } else {
      trackTitle = rawTitle;
    }
    var concert = artist ? checkUpcomingConcert(artist) : null;
    log('⚠️ Partial display (no album/artwork): ' + artist + ' / ' + trackTitle, 'log-wait');
    fadeIn(artist, trackTitle, '', '', null, concert);
  }

  // ── POLL ─────────────────────────────────────────────────
  function fetchNowPlaying() {
    fetch(STATUS_URL, { cache: 'no-store' })
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data) {
        var track = data.current_track;
        if (!track) { log('⚠️ No current_track', 'log-fail'); return; }

        var rawTitle = track.title || '';

        if (rawTitle === pendingTitle) {
          if (rawTitle !== confirmedTitle) {
            confirmedTitle = rawTitle;
            log('⏳ Confirmed: ' + rawTitle, 'log-wait');
            fadeOut().then(function() {
              fillGapIfNeeded(); // show info fills the verification gap, if configured
              fetchAndVerifyV2(rawTitle, 1);
            });
          }
        } else {
          if (rawTitle !== confirmedTitle && isVisible && displayMode === 'track') {
            log('⬇️ New title — fading out stale metadata', 'log-wait');
            fadeOut();
          }
          pendingTitle = rawTitle;
          log('⏳ Holding: ' + rawTitle, 'log-wait');
        }
        fillGapIfNeeded();
      })
      .catch(function(err) {
        log('❌ Poll failed: ' + err.message, 'log-fail');
        fillGapIfNeeded();
      });
  }

  // ── INIT ─────────────────────────────────────────────────
  function init() {
    grabDom();
    Promise.all([loadUpcomingAlbums(), loadUpcomingConcerts(), loadShowSchedule()]).then(function() {
      fillGapIfNeeded();
      fetchNowPlaying();
      setInterval(fetchNowPlaying, POLL_INTERVAL_MS);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
