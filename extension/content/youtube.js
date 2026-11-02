// Lá Chắn — YouTube helper (isolated world, registered only when the YouTube list is on).
//
// The "Lá Chắn – YouTube" list removes ad data from the player responses. When an ad
// still slips through (server-side insertion, A/B tests…), this script:
//   • clicks "Skip" as soon as it exists, otherwise mutes the ad and jumps to its end
//   • removes the "ad blockers are not allowed" dialog and resumes playback
//   • resumes the main video when it gets paused without a user gesture (the player
//     often stalls in "paused" after an ad was skipped or pruned)
(() => {
  'use strict';
  if (globalThis.__lachanYouTube) return;
  globalThis.__lachanYouTube = true;

  const SKIP_BUTTONS = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-slot button',
    'button[id^="skip-button"]',
  ].join(',');

  const saved = new WeakMap(); // video → { muted, rate }

  const playerOf = () => document.querySelector('#movie_player, .html5-video-player');

  function handleAd(player) {
    const video = player.querySelector('video');
    if (!video) return;
    const skip = player.querySelector(SKIP_BUTTONS);
    if (skip) {
      skip.click();
      return;
    }
    if (!saved.has(video)) saved.set(video, { muted: video.muted, rate: video.playbackRate === 16 ? 1 : video.playbackRate });
    video.muted = true;
    if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.3) {
      try {
        video.currentTime = video.duration - 0.1;
      } catch { /* not seekable yet */ }
    }
    try {
      video.playbackRate = 16;
    } catch { /* ignore */ }
  }

  function restore(player) {
    const video = player.querySelector('video');
    if (!video || !saved.has(video)) return;
    const prev = saved.get(video);
    saved.delete(video);
    video.muted = prev.muted;
    video.playbackRate = prev.rate || 1;
  }

  function removeEnforcementDialog() {
    const msg = document.querySelector('ytd-enforcement-message-view-model');
    if (!msg) return;
    const dialog = msg.closest('tp-yt-paper-dialog');
    (dialog || msg).remove();
    for (const backdrop of document.querySelectorAll('tp-yt-iron-overlay-backdrop')) backdrop.remove();
    document.body?.style.removeProperty('overflow');
    const video = document.querySelector('#movie_player video');
    if (video && video.paused) video.play().catch(() => {});
  }

  // Pauses the user did not ask for → play again. A pause within GESTURE_MS of a
  // click/tap/key press is treated as the user's; after MAX_RESUMES forced resumes in
  // RESUME_WINDOW_MS we back off so we never fight the page in a loop.
  const GESTURE_MS = 1000;
  const RESUME_DELAY_MS = 300;
  const MAX_RESUMES = 3;
  const RESUME_WINDOW_MS = 10000;
  let lastGesture = 0;
  let resumes = [];

  const markGesture = (ev) => {
    if (ev.isTrusted) lastGesture = Date.now();
  };

  function maybeResume(video) {
    const player = playerOf();
    if (!player || !player.contains(video) || !video.paused || video.ended) return;
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) return;
    if (player.classList.contains('ended-mode')) return;
    if (Date.now() - lastGesture < GESTURE_MS + RESUME_DELAY_MS) return;
    if (Number.isFinite(video.duration) && video.currentTime >= video.duration - 0.5) return;
    const now = Date.now();
    resumes = resumes.filter((t) => now - t < RESUME_WINDOW_MS);
    if (resumes.length >= MAX_RESUMES) return;
    resumes.push(now);
    video.play().catch(() => {});
  }

  const onPause = (ev) => {
    const video = ev.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (Date.now() - lastGesture < GESTURE_MS) return;
    setTimeout(() => maybeResume(video), RESUME_DELAY_MS);
  };

  function tick() {
    const player = playerOf();
    if (player) {
      const adShowing = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
      if (adShowing) handleAd(player);
      else restore(player);
    }
    removeEnforcementDialog();
  }

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      tick();
    });
  };

  const start = () => {
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      document.addEventListener(type, markGesture, true);
    }
    document.addEventListener('pause', onPause, true); // media events don't bubble, capture does
    new MutationObserver(schedule).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    setInterval(tick, 1000); // safety net when the tab is in the background
    tick();
  };

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
