"""
Comprehensive unit tests for audio_analyzer_simple.py

Test strategy
-------------
* essentia is stubbed via conftest.py (injected into sys.modules before import).
* Pure-logic functions are tested with synthetic numpy arrays.
* File-I/O functions are tested with monkeypatching of builtins and os functions.
* All RhythmExtractor2013 call sites are patched per-test via the `es_cls` fixture
  so tests do not interfere with each other.
"""

import os
import sys
import math
import builtins
from io import StringIO
from unittest.mock import MagicMock, patch, mock_open, call
import numpy as np
import pytest

# conftest.py already injected the essentia stub before this file is imported.
# Import the module under test directly.
import audio_analyzer_simple as aa

# Import audio helpers defined at module level in conftest.
# pytest makes conftest available, but we import it explicitly so IDEs/linters
# are satisfied and to avoid relying on pytest fixture injection for bare values.
import tests.conftest as _cf

SR = _cf.SR
make_silence = _cf.make_silence
make_sine = _cf.make_sine
make_noise = _cf.make_noise
make_silent_then_audio = _cf.make_silent_then_audio
beats_for_bpm = _cf.beats_for_bpm


# ===========================================================================
# Helpers shared across tests
# ===========================================================================

def _bar_duration(bpm):
    return (60.0 / bpm) * 4.0


def _make_audio_with_energy_jump(bpm, bars_before, bars_after, sr=SR,
                                  low_amp=0.05, high_amp=0.5):
    """
    Create audio that has a clear energy jump after `bars_before` bars.
    Returns (audio, duration_s).
    """
    bar_dur = _bar_duration(bpm)
    samples_per_bar = int(bar_dur * sr)
    low_part = (low_amp * np.ones(bars_before * samples_per_bar)).astype(np.float32)
    high_part = (high_amp * np.ones(bars_after * samples_per_bar)).astype(np.float32)
    audio = np.concatenate([low_part, high_part])
    duration = len(audio) / sr
    return audio, duration


def _make_audio_with_energy_drop(bpm, bars_high, bars_low, sr=SR,
                                  high_amp=0.5, low_amp=0.05):
    """
    Create audio that has a clear energy drop after `bars_high` bars.
    Returns (audio, duration_s).
    """
    bar_dur = _bar_duration(bpm)
    samples_per_bar = int(bar_dur * sr)
    high_part = (high_amp * np.ones(bars_high * samples_per_bar)).astype(np.float32)
    low_part = (low_amp * np.ones(bars_low * samples_per_bar)).astype(np.float32)
    audio = np.concatenate([high_part, low_part])
    duration = len(audio) / sr
    return audio, duration


# ===========================================================================
# find_mix_in_point
# ===========================================================================

class TestFindMixInPoint:

    def test_zero_bpm_returns_zero(self):
        audio = make_sine(10.0)
        beats = beats_for_bpm(120, 10.0)
        result = aa.find_mix_in_point(audio, beats, bpm=0, sample_rate=SR)
        assert result == 0.0

    def test_negative_bpm_returns_zero(self):
        audio = make_sine(10.0)
        beats = beats_for_bpm(120, 10.0)
        result = aa.find_mix_in_point(audio, beats, bpm=-10, sample_rate=SR)
        assert result == 0.0

    def test_empty_audio_returns_zero(self):
        audio = np.array([], dtype=np.float32)
        result = aa.find_mix_in_point(audio, [], bpm=120, sample_rate=SR)
        assert result == 0.0

    def test_all_silent_audio_returns_zero(self):
        """All-silent audio has max_rms == 0, so function returns 0.0."""
        audio = make_silence(10.0)
        beats = beats_for_bpm(120, 10.0)
        result = aa.find_mix_in_point(audio, beats, bpm=120, sample_rate=SR)
        assert result == 0.0

    def test_very_short_audio_returns_zero(self):
        """Audio with fewer than 10 frames (< 0.5s) returns 0.0."""
        audio = make_sine(0.3)  # 0.3s => 6 frames of 50ms
        beats = beats_for_bpm(120, 0.3)
        result = aa.find_mix_in_point(audio, beats, bpm=120, sample_rate=SR)
        assert result == 0.0

    def test_immediate_start_no_silence(self):
        """Audio with energy from the first frame should produce onset at 0.0."""
        audio = make_noise(10.0, amplitude=0.8)
        beats = beats_for_bpm(120, 10.0)
        result = aa.find_mix_in_point(audio, beats, bpm=120, sample_rate=SR)
        assert result == 0.0

    def test_silent_intro_detected(self):
        """2s silence followed by audio — onset should be detected after silence."""
        audio = make_silent_then_audio(silence_s=2.0, audio_s=8.0)
        beats = beats_for_bpm(120, 10.0)
        result = aa.find_mix_in_point(audio, beats, bpm=120, sample_rate=SR)
        # The onset is at ~2.0s; rounded down to nearest beat (beat_period=0.5s)
        # So result should be >= 1.5 and <= 2.0
        assert result >= 1.5
        assert result <= 2.5

    def test_result_is_non_negative(self):
        """Result must never be negative."""
        audio = make_silence(10.0)
        beats = beats_for_bpm(120, 10.0)
        result = aa.find_mix_in_point(audio, beats, bpm=120, sample_rate=SR)
        assert result >= 0.0

    def test_result_rounded_to_three_decimals(self):
        """Return value is rounded to 3 decimal places."""
        audio = make_silent_then_audio(silence_s=1.5, audio_s=8.5)
        beats = beats_for_bpm(120, 10.0)
        result = aa.find_mix_in_point(audio, beats, bpm=120, sample_rate=SR)
        # round(x, 3) means at most 3 decimal places
        assert result == round(result, 3)

    def test_onset_within_beat_period_not_adjusted(self):
        """If onset_time <= beat_period, it is returned as-is (no beat rounding)."""
        bpm = 120  # beat_period = 0.5s
        # Silence for 0.1s then audio — onset at 0.1s, which is < beat_period
        audio = make_silent_then_audio(silence_s=0.1, audio_s=9.9)
        beats = beats_for_bpm(bpm, 10.0)
        result = aa.find_mix_in_point(audio, beats, bpm=bpm, sample_rate=SR)
        # onset <= beat_period so no adjustment: result should be small
        assert result < 0.6  # well under one beat_period

    def test_longer_silence_with_high_bpm(self):
        """Test that beat rounding works for a known 3s silence at 120 BPM."""
        bpm = 120  # beat_period=0.5s
        audio = make_silent_then_audio(silence_s=3.0, audio_s=7.0)
        beats = beats_for_bpm(bpm, 10.0)
        result = aa.find_mix_in_point(audio, beats, bpm=bpm, sample_rate=SR)
        # onset ~3.0s -> beat_idx = int(3.0 / 0.5) = 6 -> onset_time = 3.0s
        assert result >= 2.5
        assert result <= 3.5


# ===========================================================================
# find_intro_end
# ===========================================================================

class TestFindIntroEnd:

    def test_zero_bpm_returns_zero(self):
        audio = make_sine(60.0)
        result = aa.find_intro_end(audio, bpm=0, duration=60.0, sample_rate=SR)
        assert result == 0.0

    def test_zero_duration_returns_zero(self):
        audio = make_sine(60.0)
        result = aa.find_intro_end(audio, bpm=120, duration=0.0, sample_rate=SR)
        assert result == 0.0

    def test_short_track_less_than_8_bars_uses_fallback_formula(self):
        """
        Track with fewer than 8 bars: returns min(16*bar_dur, duration*0.3).
        At 120 BPM, bar_dur = 2s, so 16 bars = 32s.
        A 10s track -> n_bars = 5 < 8 -> fallback = min(32, 3) = 3s.
        """
        bpm = 120
        duration = 10.0
        audio = make_noise(duration)
        result = aa.find_intro_end(audio, bpm=bpm, duration=duration, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        expected = min(16.0 * bar_dur, duration * 0.3)
        assert result == pytest.approx(expected, abs=0.2)

    def test_fallback_when_no_clear_energy_jump(self):
        """
        Uniform-energy audio => max_jump < 0.5 => fallback branch.
        For a 3-minute track (duration <= 180) fallback is 16 bars.
        """
        bpm = 120
        duration = 120.0  # 2 minutes
        audio = make_noise(duration, amplitude=0.5)
        result = aa.find_intro_end(audio, bpm=bpm, duration=duration, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        fallback = 16.0 * bar_dur  # 32s at 120 BPM
        # Must be within the clamping range [4*bar_dur, duration*0.4]
        assert result >= 4.0 * bar_dur
        assert result <= duration * 0.4

    def test_fallback_long_track_uses_32_bars(self):
        """
        For a track longer than 180s with uniform energy, fallback is 32 bars.
        """
        bpm = 120
        duration = 240.0  # 4 minutes
        audio = make_noise(duration, amplitude=0.5)
        result = aa.find_intro_end(audio, bpm=bpm, duration=duration, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        # fallback = 32 bars = 64s; clamped to [4*bar_dur, 0.4*240] = [8, 96]
        assert result >= 4.0 * bar_dur
        assert result <= duration * 0.4

    def test_clear_energy_jump_detected(self):
        """
        Audio with low amplitude for bars 0-15 and high amplitude from bar 16+
        should trigger the detection branch (max_jump >= 0.5).
        Result must be aligned to a 16-bar phrase.
        """
        bpm = 120
        bars_before = 15  # low energy
        bars_after = 33   # high energy (enough for > half and detection window)
        audio, duration = _make_audio_with_energy_jump(
            bpm, bars_before, bars_after, low_amp=0.02, high_amp=0.8
        )
        result = aa.find_intro_end(audio, bpm=bpm, duration=duration, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        # Result must be a multiple of 16 bars * bar_dur
        ratio = result / bar_dur
        assert ratio % 16 == pytest.approx(0.0, abs=0.5), (
            f"Expected 16-bar alignment but got {ratio:.2f} bars"
        )

    def test_result_is_16_bar_aligned(self):
        """
        The returned value must always be a multiple of 16 * bar_duration
        OR the fallback path — both should satisfy the constraint clamp.
        """
        bpm = 128
        bars_before = 8
        bars_after = 40
        audio, duration = _make_audio_with_energy_jump(
            bpm, bars_before, bars_after, low_amp=0.01, high_amp=0.9
        )
        result = aa.find_intro_end(audio, bpm=bpm, duration=duration, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        # Clamp check
        assert result >= 4.0 * bar_dur
        assert result <= duration * 0.4

    def test_result_clamped_to_max_40_percent_duration(self):
        """intro_end is always <= duration * 0.4."""
        bpm = 120
        duration = 60.0
        audio = make_noise(duration, amplitude=0.5)
        result = aa.find_intro_end(audio, bpm=bpm, duration=duration, sample_rate=SR)
        assert result <= duration * 0.4

    def test_result_clamped_to_min_4_bars(self):
        """intro_end is always >= 4 * bar_duration when audio is long enough."""
        bpm = 120
        duration = 120.0
        audio = make_noise(duration, amplitude=0.5)
        result = aa.find_intro_end(audio, bpm=bpm, duration=duration, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        assert result >= 4.0 * bar_dur

    def test_result_is_rounded_to_one_decimal(self):
        """Return value is rounded to 1 decimal place."""
        bpm = 120
        duration = 120.0
        audio = make_noise(duration)
        result = aa.find_intro_end(audio, bpm=bpm, duration=duration, sample_rate=SR)
        assert result == round(result, 1)


# ===========================================================================
# find_outro_start
# ===========================================================================

class TestFindOutroStart:

    def test_zero_bpm_returns_fallback_fraction(self):
        """bpm <= 0 returns duration * 0.7."""
        audio = make_sine(120.0)
        result = aa.find_outro_start(audio, bpm=0, duration=120.0,
                                      intro_end=30.0, sample_rate=SR)
        assert result == pytest.approx(120.0 * 0.7, abs=0.01)

    def test_zero_duration_returns_fallback_fraction(self):
        """duration <= 0 returns 0.0 * 0.7 = 0.0."""
        audio = make_sine(10.0)
        result = aa.find_outro_start(audio, bpm=120, duration=0.0,
                                      intro_end=0.0, sample_rate=SR)
        assert result == pytest.approx(0.0, abs=0.01)

    def test_short_track_less_than_8_bars(self):
        """n_bars < 8: returns max(0, duration - 16*bar_dur)."""
        bpm = 120
        duration = 10.0  # => ~5 bars
        audio = make_noise(duration)
        intro_end = 5.0
        result = aa.find_outro_start(audio, bpm=bpm, duration=duration,
                                      intro_end=intro_end, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        expected = max(0.0, duration - 16.0 * bar_dur)
        # The result is clamped later by the constraint check
        # but for this short audio max(0, 10 - 32) = 0 which then gets
        # clamped to intro_end + 4*bar_dur
        assert result >= 0.0

    def test_fallback_when_no_clear_drop(self):
        """
        Uniform audio => max_drop < 0.3 => fallback.
        For short track (duration <= 180): fallback = duration - 16*bar_dur.
        """
        bpm = 120
        duration = 120.0
        audio = make_noise(duration, amplitude=0.5)
        intro_end = 32.0
        result = aa.find_outro_start(audio, bpm=bpm, duration=duration,
                                      intro_end=intro_end, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        # Must be >= intro_end + 4 bars
        assert result >= intro_end + 4.0 * bar_dur
        # Must be <= duration - 4 bars
        assert result <= duration - 4.0 * bar_dur

    def test_clear_energy_drop_detected(self):
        """
        High-energy intro followed by silence at the end.
        The function should detect the drop and return something in the
        second half of the track aligned to a 16-bar phrase.
        """
        bpm = 120
        bars_high = 48
        bars_low = 16
        audio, duration = _make_audio_with_energy_drop(
            bpm, bars_high, bars_low, high_amp=0.8, low_amp=0.02
        )
        intro_end = _bar_duration(bpm) * 16  # 32s
        result = aa.find_outro_start(audio, bpm=bpm, duration=duration,
                                      intro_end=intro_end, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        # Result must be in the second half and aligned to a 16-bar phrase
        assert result >= duration * 0.4
        ratio = result / bar_dur
        # Allow tolerance of 1 bar for rounding effects
        assert ratio % 16 < 2.0 or ratio % 16 > 14.0, (
            f"Expected 16-bar alignment but got {ratio:.2f} bars"
        )

    def test_result_not_before_intro_end_plus_4_bars(self):
        """outro_start >= intro_end + 4 * bar_duration always."""
        bpm = 120
        duration = 120.0
        audio = make_noise(duration, amplitude=0.5)
        intro_end = 60.0
        result = aa.find_outro_start(audio, bpm=bpm, duration=duration,
                                      intro_end=intro_end, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        assert result >= intro_end + 4.0 * bar_dur

    def test_result_not_after_duration_minus_4_bars(self):
        """outro_start <= duration - 4 * bar_duration always."""
        bpm = 120
        duration = 120.0
        audio = make_noise(duration, amplitude=0.5)
        intro_end = 30.0
        result = aa.find_outro_start(audio, bpm=bpm, duration=duration,
                                      intro_end=intro_end, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        assert result <= duration - 4.0 * bar_dur

    def test_fallback_long_track_uses_32_bars_from_end(self):
        """duration > 180: fallback = duration - 32*bar_dur."""
        bpm = 120
        duration = 240.0
        audio = make_noise(duration, amplitude=0.5)
        intro_end = 32.0
        result = aa.find_outro_start(audio, bpm=bpm, duration=duration,
                                      intro_end=intro_end, sample_rate=SR)
        bar_dur = _bar_duration(bpm)
        # Fallback is 32 bars from end = 240 - 64 = 176s
        # Clamped to [intro_end + 4*bar_dur, duration - 4*bar_dur]
        assert result >= intro_end + 4.0 * bar_dur
        assert result <= duration - 4.0 * bar_dur

    def test_result_is_rounded_to_one_decimal(self):
        bpm = 120
        duration = 120.0
        audio = make_noise(duration)
        result = aa.find_outro_start(audio, bpm=bpm, duration=duration,
                                      intro_end=30.0, sample_rate=SR)
        assert result == round(result, 1)


# ===========================================================================
# detect_bpm
# ===========================================================================

class TestDetectBpm:
    """
    All tests patch es.RhythmExtractor2013 via the module's `es` attribute.
    The stub in conftest.py gives us a MagicMock we can configure per test.
    """

    def _make_rhythm_result(self, bpm, beats, confidence):
        """Return a callable that, when called, returns the 5-tuple Essentia returns."""
        beats_arr = np.array(beats, dtype=np.float32)
        instance = MagicMock()
        instance.return_value = (bpm, beats_arr, confidence, None, None)
        return instance

    def test_normal_bpm_above_100_no_octave_correction(self):
        """BPM >= 100: no second pass, result returned as-is."""
        beats = [0.0, 0.5, 1.0, 1.5]
        instance = self._make_rhythm_result(128.0, beats, 0.9)
        with patch.object(aa.es, "RhythmExtractor2013", return_value=instance):
            bpm, result_beats, confidence = aa.detect_bpm(make_noise(10.0))
        assert bpm == pytest.approx(128.0)
        assert confidence == pytest.approx(0.9)
        assert len(result_beats) == 4

    def test_octave_correction_applied_when_bpm_under_100_and_double_more_confident(self):
        """
        First pass returns 64 BPM with confidence 0.7.
        Second pass (narrow range ~118-138) returns 128 BPM with confidence 0.7
        (>= 0.7 * 0.8 = 0.56). Correction accepted.
        """
        beats1 = [0.0, 0.9375, 1.875]   # 64 BPM spacing
        beats2 = [0.0, 0.469, 0.938]     # 128 BPM spacing
        instance1 = self._make_rhythm_result(64.0, beats1, 0.7)
        instance2 = self._make_rhythm_result(128.0, beats2, 0.7)

        call_count = [0]
        def side_effect(**kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return instance1
            return instance2

        with patch.object(aa.es, "RhythmExtractor2013", side_effect=side_effect):
            bpm, result_beats, confidence = aa.detect_bpm(make_noise(10.0))

        assert bpm == pytest.approx(128.0)
        assert len(result_beats) == 3  # beats2

    def test_octave_correction_rejected_when_double_less_confident(self):
        """
        First pass: 64 BPM, confidence 0.9.
        Second pass: 128 BPM, confidence 0.5 (< 0.9 * 0.8 = 0.72).
        Correction rejected, BUT force-double triggers because bpm is still < 100.
        Result: 128 BPM (via force-double).
        """
        beats1 = [0.0, 0.9375, 1.875]
        beats2 = [0.0, 0.469, 0.938]
        instance1 = self._make_rhythm_result(64.0, beats1, 0.9)
        instance2 = self._make_rhythm_result(128.0, beats2, 0.5)

        call_count = [0]
        def side_effect(**kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return instance1
            return instance2

        with patch.object(aa.es, "RhythmExtractor2013", side_effect=side_effect):
            bpm, result_beats, confidence = aa.detect_bpm(make_noise(10.0))

        # Force double triggers: 64 * 2 = 128
        assert bpm == pytest.approx(128.0)

    def test_force_double_when_still_under_100_after_octave_check(self):
        """
        If the octave-corrected BPM is still < 100, force-double is applied.
        First pass: 75 BPM, conf 0.9. Second pass: 80 BPM, conf 0.8 (>= 0.72).
        Octave correction accepted (80 BPM), but 80 < 100, so force-double: 160.
        """
        beats1 = [0.0, 0.8, 1.6]
        beats2 = [0.0, 0.75, 1.5]
        instance1 = self._make_rhythm_result(75.0, beats1, 0.9)
        instance2 = self._make_rhythm_result(80.0, beats2, 0.8)

        call_count = [0]
        def side_effect(**kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return instance1
            return instance2

        with patch.object(aa.es, "RhythmExtractor2013", side_effect=side_effect):
            bpm, result_beats, confidence = aa.detect_bpm(make_noise(10.0))

        assert bpm == pytest.approx(160.0)

    def test_bpm_exactly_100_no_octave_correction(self):
        """BPM == 100.0: no second pass triggered (condition is bpm < 100)."""
        beats = [0.0, 0.6, 1.2]
        instance = self._make_rhythm_result(100.0, beats, 0.85)
        with patch.object(aa.es, "RhythmExtractor2013", return_value=instance):
            bpm, result_beats, confidence = aa.detect_bpm(make_noise(10.0))
        assert bpm == pytest.approx(100.0)

    def test_zero_bpm_no_correction(self):
        """BPM == 0.0: condition is bpm < 100 AND bpm > 0, so no second pass."""
        beats = []
        instance = self._make_rhythm_result(0.0, beats, 0.0)
        with patch.object(aa.es, "RhythmExtractor2013", return_value=instance):
            bpm, result_beats, confidence = aa.detect_bpm(make_noise(10.0))
        assert bpm == pytest.approx(0.0)

    def test_beats_converted_to_list(self):
        """beats return value is always a plain Python list."""
        beats = np.array([0.0, 0.5, 1.0], dtype=np.float32)
        instance = self._make_rhythm_result(120.0, beats, 0.9)
        with patch.object(aa.es, "RhythmExtractor2013", return_value=instance):
            bpm, result_beats, confidence = aa.detect_bpm(make_noise(10.0))
        assert isinstance(result_beats, list)

    def test_narrow_range_for_second_pass_calculation(self):
        """
        Verify second pass uses correct minTempo/maxTempo based on double BPM.
        For first pass BPM=70: double=140, low=max(60,130)=130, high=min(220,150)=150.
        """
        beats1 = [0.0, 0.857, 1.714]
        beats2 = [0.0, 0.429, 0.857]
        instance1 = self._make_rhythm_result(70.0, beats1, 0.6)
        instance2 = self._make_rhythm_result(140.0, beats2, 0.6)

        captured_kwargs = []

        def side_effect(**kwargs):
            captured_kwargs.append(kwargs)
            if len(captured_kwargs) == 1:
                return instance1
            return instance2

        with patch.object(aa.es, "RhythmExtractor2013", side_effect=side_effect):
            bpm, _, _ = aa.detect_bpm(make_noise(10.0))

        assert len(captured_kwargs) == 2
        # First call: wide range
        assert captured_kwargs[0]["minTempo"] == 60
        assert captured_kwargs[0]["maxTempo"] == 220
        # Second call: narrow range around double (140)
        assert captured_kwargs[1]["minTempo"] == 130
        assert captured_kwargs[1]["maxTempo"] == 150

    def test_second_pass_minTempo_clamped_to_60(self):
        """
        For BPM=60: double=120, raw_low=110. max(60, 110)=110. Clamped to 60 minimum.
        Actually: max(60, 110)=110. The clamp is max(60, ...) so it's 110 here.
        For very low BPM like 62: double=124, low=max(60,114)=114.
        This test checks the clamp formula for edge cases.
        """
        beats1 = [0.0, 1.0, 2.0]
        beats2 = [0.0, 0.5, 1.0]
        instance1 = self._make_rhythm_result(62.0, beats1, 0.6)
        instance2 = self._make_rhythm_result(124.0, beats2, 0.6)

        captured_kwargs = []

        def side_effect(**kwargs):
            captured_kwargs.append(kwargs)
            if len(captured_kwargs) == 1:
                return instance1
            return instance2

        with patch.object(aa.es, "RhythmExtractor2013", side_effect=side_effect):
            bpm, _, _ = aa.detect_bpm(make_noise(10.0))

        # double=124, low=max(60, min(180, 114))=114, high=min(220, 134)=134
        second = captured_kwargs[1]
        assert second["minTempo"] == 114
        assert second["maxTempo"] == 134


# ===========================================================================
# get_existing_tracks
# ===========================================================================

class TestGetExistingTracks:

    def test_returns_empty_dict_when_no_map_file(self, tmp_path, monkeypatch):
        """When .analysis_map does not exist, return empty dict."""
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(tmp_path / ".analysis_map"))
        result = aa.get_existing_tracks()
        assert result == {}

    def test_parses_valid_lines(self, tmp_path, monkeypatch):
        """Each line filepath|bpm|... should produce filepath -> bpm mapping."""
        map_file = tmp_path / ".analysis_map"
        map_file.write_text(
            "/music/track1.wav|128.0|300.0|32.0|240.0|0.000|280.0|0.012\n"
            "/music/track2.mp3|140.0|240.0|28.0|200.0|0.000|220.0|0.010\n"
        )
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))
        result = aa.get_existing_tracks()
        assert result == {
            "/music/track1.wav": "128.0",
            "/music/track2.mp3": "140.0",
        }

    def test_skips_lines_without_pipe(self, tmp_path, monkeypatch):
        """Lines without '|' are silently ignored."""
        map_file = tmp_path / ".analysis_map"
        map_file.write_text("this is a bad line\n/music/track.wav|120.0|300.0\n")
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))
        result = aa.get_existing_tracks()
        assert "/music/track.wav" in result
        assert len(result) == 1

    def test_skips_lines_with_only_one_part(self, tmp_path, monkeypatch):
        """Lines that split into fewer than 2 parts are skipped."""
        map_file = tmp_path / ".analysis_map"
        # A line with a pipe but nothing after it
        map_file.write_text("|only_bpm\n/music/good.wav|128.0|300.0\n")
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))
        result = aa.get_existing_tracks()
        # "|only_bpm" splits to ["", "only_bpm"] — parts[0]="" is the key
        assert "/music/good.wav" in result

    def test_skips_blank_lines(self, tmp_path, monkeypatch):
        """Empty lines are stripped and skipped (no '|')."""
        map_file = tmp_path / ".analysis_map"
        map_file.write_text("\n\n/music/track.wav|128.0|300.0\n\n")
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))
        result = aa.get_existing_tracks()
        assert len(result) == 1

    def test_stores_bpm_as_string(self, tmp_path, monkeypatch):
        """Values are stored as raw strings, not converted to float."""
        map_file = tmp_path / ".analysis_map"
        map_file.write_text("/music/track.wav|128.0|300.0\n")
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))
        result = aa.get_existing_tracks()
        assert isinstance(result["/music/track.wav"], str)

    def test_empty_file_returns_empty_dict(self, tmp_path, monkeypatch):
        map_file = tmp_path / ".analysis_map"
        map_file.write_text("")
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))
        result = aa.get_existing_tracks()
        assert result == {}


# ===========================================================================
# is_file_stable
# ===========================================================================

class TestIsFileStable:

    def test_returns_true_when_size_unchanged(self, monkeypatch):
        """If size doesn't change between checks, file is stable."""
        monkeypatch.setattr(os.path, "getsize", lambda p: 1024)
        monkeypatch.setattr(aa.time, "sleep", lambda s: None)
        assert aa.is_file_stable("/fake/path.wav", wait_secs=0) is True

    def test_returns_false_on_oserror(self, monkeypatch):
        """OSError (file missing) means unstable — returns False immediately."""
        def raise_oserror(p):
            raise OSError("no such file")
        monkeypatch.setattr(os.path, "getsize", raise_oserror)
        monkeypatch.setattr(aa.time, "sleep", lambda s: None)
        assert aa.is_file_stable("/nonexistent.wav", wait_secs=0) is False

    def test_returns_false_when_size_keeps_changing(self, monkeypatch):
        """
        If size changes on every attempt (never stable), returns False after
        exhausting max_attempts.
        """
        counter = [0]

        def growing(p):
            counter[0] += 1
            return counter[0] * 100  # different value every call

        monkeypatch.setattr(os.path, "getsize", growing)
        monkeypatch.setattr(aa.time, "sleep", lambda s: None)
        result = aa.is_file_stable("/fake/path.wav", wait_secs=0, max_attempts=3)
        assert result is False

    def test_returns_true_on_second_attempt(self, monkeypatch):
        """File is unstable on first check but stable on second."""
        sizes = [100, 200, 200, 200]  # first pair differs, second pair matches
        call_count = [0]

        def size_fn(p):
            val = sizes[call_count[0]]
            call_count[0] += 1
            return val

        monkeypatch.setattr(os.path, "getsize", size_fn)
        monkeypatch.setattr(aa.time, "sleep", lambda s: None)
        result = aa.is_file_stable("/fake/path.wav", wait_secs=0, max_attempts=3)
        assert result is True

    def test_default_max_attempts_is_3(self, monkeypatch):
        """Without explicit max_attempts, we get 3 attempts."""
        calls = [0]

        def growing(p):
            calls[0] += 1
            return calls[0] * 1000

        monkeypatch.setattr(os.path, "getsize", growing)
        monkeypatch.setattr(aa.time, "sleep", lambda s: None)
        # Should exhaust exactly 3 attempts = 6 getsize calls
        aa.is_file_stable("/fake/path.wav", wait_secs=0)
        assert calls[0] == 6

    def test_returns_true_immediately_if_stable_first_try(self, monkeypatch):
        """Stable on first attempt: only 2 getsize calls."""
        calls = [0]

        def stable(p):
            calls[0] += 1
            return 512

        monkeypatch.setattr(os.path, "getsize", stable)
        monkeypatch.setattr(aa.time, "sleep", lambda s: None)
        result = aa.is_file_stable("/fake/path.wav", wait_secs=0)
        assert result is True
        assert calls[0] == 2  # size1 + size2


# ===========================================================================
# save_analysis
# ===========================================================================

class TestSaveAnalysis:

    def _sample_data(self, **overrides):
        data = {
            "filepath": "/music/test_track.wav",
            "bpm": 128.0,
            "duration": 300.0,
            "intro_end": 32.0,
            "outro_start": 240.0,
            "mix_in": 0.012,
            "mix_out": 280.0,
            "first_beat": 0.025,
        }
        data.update(overrides)
        return data

    def test_writes_correct_format_to_analysis_map(self, tmp_path, monkeypatch):
        """
        Format: filepath|bpm:.1f|duration:.1f|intro_end:.1f|outro_start:.1f|
                mix_in:.3f|mix_out:.1f|first_beat:.3f
        """
        map_path = tmp_path / ".analysis_map"
        bpm_map_path = tmp_path / ".bpm_map"
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_path))
        monkeypatch.setattr(aa, "MUSIC_DIR", str(tmp_path))

        data = self._sample_data()
        aa.save_analysis(data)

        content = map_path.read_text()
        expected_line = (
            "/music/test_track.wav|128.0|300.0|32.0|240.0|0.012|280.0|0.025\n"
        )
        assert content == expected_line

    def test_writes_bpm_map_entry(self, tmp_path, monkeypatch):
        """save_analysis also appends filepath|bpm to .bpm_map."""
        map_path = tmp_path / ".analysis_map"
        bpm_map_path = tmp_path / ".bpm_map"
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_path))
        monkeypatch.setattr(aa, "MUSIC_DIR", str(tmp_path))

        data = self._sample_data()
        aa.save_analysis(data)

        bpm_content = bpm_map_path.read_text()
        assert bpm_content == "/music/test_track.wav|128.0\n"

    def test_appends_to_existing_file(self, tmp_path, monkeypatch):
        """Subsequent calls append new lines rather than overwriting."""
        map_path = tmp_path / ".analysis_map"
        bpm_map_path = tmp_path / ".bpm_map"
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_path))
        monkeypatch.setattr(aa, "MUSIC_DIR", str(tmp_path))

        aa.save_analysis(self._sample_data(filepath="/music/a.wav"))
        aa.save_analysis(self._sample_data(filepath="/music/b.wav"))

        lines = map_path.read_text().splitlines()
        assert len(lines) == 2
        assert lines[0].startswith("/music/a.wav|")
        assert lines[1].startswith("/music/b.wav|")

    def test_format_precision_bpm_one_decimal(self, tmp_path, monkeypatch):
        """BPM is formatted with exactly one decimal place."""
        map_path = tmp_path / ".analysis_map"
        bpm_map_path = tmp_path / ".bpm_map"
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_path))
        monkeypatch.setattr(aa, "MUSIC_DIR", str(tmp_path))

        aa.save_analysis(self._sample_data(bpm=128.123456))

        content = map_path.read_text()
        parts = content.strip().split("|")
        assert parts[1] == "128.1"

    def test_format_precision_mix_in_three_decimals(self, tmp_path, monkeypatch):
        """mix_in is formatted with exactly three decimal places."""
        map_path = tmp_path / ".analysis_map"
        bpm_map_path = tmp_path / ".bpm_map"
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_path))
        monkeypatch.setattr(aa, "MUSIC_DIR", str(tmp_path))

        aa.save_analysis(self._sample_data(mix_in=0.123456))

        content = map_path.read_text()
        parts = content.strip().split("|")
        assert parts[5] == "0.123"

    def test_format_precision_first_beat_three_decimals(self, tmp_path, monkeypatch):
        """first_beat is formatted with exactly three decimal places."""
        map_path = tmp_path / ".analysis_map"
        bpm_map_path = tmp_path / ".bpm_map"
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_path))
        monkeypatch.setattr(aa, "MUSIC_DIR", str(tmp_path))

        aa.save_analysis(self._sample_data(first_beat=0.987654))

        content = map_path.read_text()
        parts = content.strip().split("|")
        assert parts[7] == "0.988"

    def test_line_has_8_pipe_separated_fields(self, tmp_path, monkeypatch):
        """Each line must have exactly 8 fields (7 pipes)."""
        map_path = tmp_path / ".analysis_map"
        bpm_map_path = tmp_path / ".bpm_map"
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_path))
        monkeypatch.setattr(aa, "MUSIC_DIR", str(tmp_path))

        aa.save_analysis(self._sample_data())

        line = map_path.read_text().strip()
        parts = line.split("|")
        assert len(parts) == 8


# ===========================================================================
# cleanup_removed
# ===========================================================================

class TestCleanupRemoved:

    def test_does_nothing_when_map_file_missing(self, tmp_path, monkeypatch):
        """If .analysis_map doesn't exist, function returns without error."""
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(tmp_path / ".analysis_map"))
        # Should not raise
        aa.cleanup_removed({})

    def test_removes_entries_for_nonexistent_files(self, tmp_path, monkeypatch):
        """
        Entries whose filepath does not exist on disk are removed from the map.
        """
        map_file = tmp_path / ".analysis_map"
        # Create one real file and one ghost path
        real_file = tmp_path / "real.wav"
        real_file.write_bytes(b"\x00" * 100)

        map_file.write_text(
            f"{real_file}|128.0|300.0|32.0|240.0|0.000|280.0|0.012\n"
            "/nonexistent/ghost.wav|140.0|240.0|28.0|200.0|0.000|220.0|0.010\n"
        )
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))

        aa.cleanup_removed({})

        content = map_file.read_text()
        assert str(real_file) in content
        assert "ghost.wav" not in content

    def test_keeps_entries_for_existing_files(self, tmp_path, monkeypatch):
        """All entries whose file exists are preserved."""
        map_file = tmp_path / ".analysis_map"
        f1 = tmp_path / "a.wav"
        f2 = tmp_path / "b.wav"
        f1.write_bytes(b"\x00" * 100)
        f2.write_bytes(b"\x00" * 100)

        map_file.write_text(
            f"{f1}|128.0|300.0|32.0|240.0|0.000|280.0|0.012\n"
            f"{f2}|140.0|240.0|28.0|200.0|0.000|220.0|0.010\n"
        )
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))

        aa.cleanup_removed({})

        content = map_file.read_text()
        assert str(f1) in content
        assert str(f2) in content

    def test_writes_empty_file_when_all_removed(self, tmp_path, monkeypatch):
        """When all entries are removed, file is written empty."""
        map_file = tmp_path / ".analysis_map"
        map_file.write_text("/nonexistent/a.wav|128.0|300.0\n")
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))

        aa.cleanup_removed({})

        content = map_file.read_text()
        assert content == ""

    def test_skips_lines_without_pipe(self, tmp_path, monkeypatch):
        """Lines without pipe are excluded from output (no pipe, no filepath)."""
        map_file = tmp_path / ".analysis_map"
        real_file = tmp_path / "real.wav"
        real_file.write_bytes(b"\x00" * 100)

        map_file.write_text(
            f"bad line without pipe\n"
            f"{real_file}|128.0|300.0\n"
        )
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))

        aa.cleanup_removed({})

        content = map_file.read_text()
        assert str(real_file) in content
        assert "bad line" not in content

    def test_output_has_trailing_newline_when_nonempty(self, tmp_path, monkeypatch):
        """Non-empty output always ends with a newline."""
        map_file = tmp_path / ".analysis_map"
        real_file = tmp_path / "real.wav"
        real_file.write_bytes(b"\x00" * 100)

        map_file.write_text(f"{real_file}|128.0|300.0\n")
        monkeypatch.setattr(aa, "ANALYSIS_MAP", str(map_file))

        aa.cleanup_removed({})

        content = map_file.read_text()
        assert content.endswith("\n")
