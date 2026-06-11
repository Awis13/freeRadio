/**
 * tests/dashboard/track.test.js
 *
 * Unit tests for dashboard/lib/track.js — track polling and name cleaning.
 * Tests cleanTrackName and getTrackDuration indirectly through createTrackPoller.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TRACK_FILE = '/shared/current_audio.txt';
const CLEAN_TRACK_FILE = '/shared/current_track_clean.txt';
const ANALYSIS_MAP = '/music/.analysis_map';

let files = {};

beforeEach(() => {
  files = {};
  vi.useFakeTimers();
  vi.restoreAllMocks();

  vi.spyOn(fs, 'existsSync').mockImplementation(p => p in files);
  vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
    if (p in files) return files[p];
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
    files[p] = data;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

const { createTrackPoller } =
  await import('../../dashboard/lib/track.js');

// ---------------------------------------------------------------------------
// cleanTrackName (tested via clean file written by poller)
// ---------------------------------------------------------------------------
describe('cleanTrackName via poller', () => {
  it('removes file extension', () => {
    files[TRACK_FILE] = '/music/cool_track.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).not.toContain('.mp3');
    poller.stop();
  });

  it('replaces underscores with spaces', () => {
    files[TRACK_FILE] = '/music/cool_track_name.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).toBe('cool track name');
    poller.stop();
  });

  it('replaces dots with spaces', () => {
    files[TRACK_FILE] = '/music/cool.track.name.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).toBe('cool track name');
    poller.stop();
  });

  it('replaces dashes with spaces', () => {
    files[TRACK_FILE] = '/music/cool-track-name.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).toBe('cool track name');
    poller.stop();
  });

  it('removes "official" junk word', () => {
    files[TRACK_FILE] = '/music/track_official_audio.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).not.toMatch(/official/i);
    expect(files[CLEAN_TRACK_FILE]).not.toMatch(/audio/i);
    poller.stop();
  });

  it('removes "HD" junk word', () => {
    files[TRACK_FILE] = '/music/track_HD.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).not.toMatch(/\bHD\b/i);
    poller.stop();
  });

  it('removes "1080p" junk word', () => {
    files[TRACK_FILE] = '/music/track_1080p.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).not.toMatch(/1080p/i);
    poller.stop();
  });

  it('removes "remastered" junk word', () => {
    files[TRACK_FILE] = '/music/track_remastered.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).not.toMatch(/remastered/i);
    poller.stop();
  });

  it('removes "lyrics" and "video" junk words', () => {
    files[TRACK_FILE] = '/music/track_lyrics_video.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).not.toMatch(/lyrics/i);
    expect(files[CLEAN_TRACK_FILE]).not.toMatch(/video/i);
    poller.stop();
  });

  it('normalizes multiple spaces to single', () => {
    files[TRACK_FILE] = '/music/track___name.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).not.toMatch(/  /);
    poller.stop();
  });

  it('trims leading and trailing whitespace', () => {
    files[TRACK_FILE] = '/music/_track_.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).toBe('track');
    poller.stop();
  });

  it('handles combined junk: underscores, HD, official', () => {
    files[TRACK_FILE] = '/music/Artist_Name_Track_Title_Official_Audio_HD.flac';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    const clean = files[CLEAN_TRACK_FILE];
    expect(clean).not.toMatch(/official/i);
    expect(clean).not.toMatch(/\baudio\b/i);
    expect(clean).not.toMatch(/\bHD\b/i);
    expect(clean).toContain('Artist');
    expect(clean).toContain('Name');
    poller.stop();
  });
});

// ---------------------------------------------------------------------------
// getTrackDuration (tested via onUpdate callback duration field)
// ---------------------------------------------------------------------------
describe('getTrackDuration via poller', () => {
  it('returns duration from analysis map matching basename', () => {
    files[TRACK_FILE] = '/music/track_a.mp3';
    files[ANALYSIS_MAP] = '/music/track_a.mp3|142.5|245.3\n/music/track_b.mp3|138.0|300.1\n';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0].duration).toBe(245.3);
    poller.stop();
  });

  it('matches by extensionless basename', () => {
    files[TRACK_FILE] = '/music/subdir/track_a.flac';
    files[ANALYSIS_MAP] = '/music/track_a.mp3|142.5|245.3\n';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].duration).toBe(245.3);
    poller.stop();
  });

  it('returns 0 when track not found in analysis map', () => {
    files[TRACK_FILE] = '/music/unknown.mp3';
    files[ANALYSIS_MAP] = '/music/track_a.mp3|142.5|245.3\n';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].duration).toBe(0);
    poller.stop();
  });

  it('returns 0 when analysis map does not exist', () => {
    files[TRACK_FILE] = '/music/track.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].duration).toBe(0);
    poller.stop();
  });

  it('returns 0 for lines with fewer than 3 pipe-separated parts', () => {
    files[TRACK_FILE] = '/music/track.mp3';
    files[ANALYSIS_MAP] = '/music/track.mp3|142.5\n';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].duration).toBe(0);
    poller.stop();
  });

  it('returns 0 when duration field is not a number', () => {
    files[TRACK_FILE] = '/music/track.mp3';
    files[ANALYSIS_MAP] = '/music/track.mp3|142.5|not_a_number\n';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].duration).toBe(0);
    poller.stop();
  });
});

// ---------------------------------------------------------------------------
// createTrackPoller behavior
// ---------------------------------------------------------------------------
describe('createTrackPoller', () => {
  it('calls onUpdate with title, filename, duration, startedAt', () => {
    files[TRACK_FILE] = '/music/my_song.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const data = onUpdate.mock.calls[0][0];
    expect(data.title).toBe('my_song');
    expect(data.filename).toBe('/music/my_song.mp3');
    expect(typeof data.duration).toBe('number');
    expect(typeof data.startedAt).toBe('number');
    poller.stop();
  });

  it('does not call onUpdate when track file does not exist', () => {
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate).not.toHaveBeenCalled();
    poller.stop();
  });

  it('does not call onUpdate when track file is empty', () => {
    files[TRACK_FILE] = '  ';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate).not.toHaveBeenCalled();
    poller.stop();
  });

  it('does not call onUpdate again for the same track', () => {
    files[TRACK_FILE] = '/music/song.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it('calls onUpdate when track changes', () => {
    files[TRACK_FILE] = '/music/song_a.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate).toHaveBeenCalledTimes(1);

    files[TRACK_FILE] = '/music/song_b.mp3';
    vi.advanceTimersByTime(2000);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[1][0].title).toBe('song_b');

    poller.stop();
  });

  it('polls at 2-second interval', () => {
    files[TRACK_FILE] = '/music/song.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    files[TRACK_FILE] = '/music/song2.mp3';
    vi.advanceTimersByTime(2000);

    files[TRACK_FILE] = '/music/song3.mp3';
    vi.advanceTimersByTime(2000);

    expect(onUpdate).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it('stop() clears the interval', () => {
    files[TRACK_FILE] = '/music/song.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();
    poller.stop();

    files[TRACK_FILE] = '/music/different.mp3';
    vi.advanceTimersByTime(10000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('writes clean track name to clean track file', () => {
    files[TRACK_FILE] = '/music/cool_track.mp3';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(files[CLEAN_TRACK_FILE]).toBe('cool track');
    poller.stop();
  });

  it('title is basename without extension', () => {
    files[TRACK_FILE] = '/music/subdir/my_track.flac';
    const onUpdate = vi.fn();
    const poller = createTrackPoller(onUpdate);
    poller.start();

    expect(onUpdate.mock.calls[0][0].title).toBe('my_track');
    poller.stop();
  });
});
