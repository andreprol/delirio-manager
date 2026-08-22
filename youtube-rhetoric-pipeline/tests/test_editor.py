import pytest
from unittest.mock import patch, MagicMock
from pipeline.editor import (
    build_long_video, build_short, LONG_WIDTH, LONG_HEIGHT,
    SHORT_WIDTH, SHORT_HEIGHT, SHORT_MAX_SECONDS,
)
# Capturado no import: a fixture autouse abaixo substitui o atributo do módulo.
from pipeline.editor import has_audio_stream as real_has_audio_stream


@pytest.fixture(autouse=True)
def stub_probes():
    """ffprobe é chamado de verdade; com subprocess.run mockado, ele mente."""
    with (
        patch("pipeline.editor.probe_duration", return_value=30.0),
        patch("pipeline.editor.has_audio_stream", return_value=False),
    ):
        yield


def _segment(tmp_path, start=10.0, end=80.0, name="narration_0.mp3"):
    narration = tmp_path / name
    narration.touch()
    return {"clip_start": start, "clip_end": end, "narration_path": str(narration)}


def _ok_run():
    return MagicMock(returncode=0, stderr="")


def _commands(mock_run):
    return [call.args[0] for call in mock_run.call_args_list]


def test_build_long_video_is_landscape(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    segments = [_segment(tmp_path), _segment(tmp_path, 100.0, 170.0, "narration_1.mp3")]

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = _ok_run()
        result = build_long_video(
            source_path=str(source), segments=segments,
            output_dir=str(tmp_path), video_id="abc123",
        )

    assert result.endswith("abc123_long.mp4")
    filters = " ".join(
        cmd[cmd.index("-filter_complex") + 1]
        for cmd in _commands(mock_run) if "-filter_complex" in cmd
    )
    assert f"scale={LONG_WIDTH}:{LONG_HEIGHT}" in filters
    assert f"scale={SHORT_WIDTH}:{SHORT_HEIGHT}" not in filters


def test_build_long_video_renders_narration_and_clip_per_segment(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    segments = [_segment(tmp_path), _segment(tmp_path, 100.0, 170.0, "narration_1.mp3")]

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = _ok_run()
        build_long_video(
            source_path=str(source), segments=segments,
            output_dir=str(tmp_path), video_id="abc123",
        )

    # 2 segmentos x (narração + clipe) + 1 concat
    assert mock_run.call_count == 5


def test_build_long_video_includes_intro_and_outro(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    intro = tmp_path / "intro.mp4"
    intro.touch()
    outro = tmp_path / "outro.mp4"
    outro.touch()

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = _ok_run()
        build_long_video(
            source_path=str(source), segments=[_segment(tmp_path)],
            output_dir=str(tmp_path), video_id="abc123",
            intro_path=str(intro), outro_path=str(outro),
        )

    concat_list = tmp_path / "abc123_long_concat.txt"
    body = concat_list.read_text(encoding="utf-8")
    assert "abc123_long_intro.mp4" in body
    assert "abc123_long_outro.mp4" in body
    # intro antes de tudo, outro depois de tudo
    assert body.index("_long_intro") < body.index("_long_0_narration")
    assert body.index("_long_outro") > body.index("_long_0_clip")


def test_build_long_video_rejects_empty_segments(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    with pytest.raises(ValueError, match="ao menos 1 segmento"):
        build_long_video(
            source_path=str(source), segments=[],
            output_dir=str(tmp_path), video_id="abc123",
        )


def test_build_short_is_portrait(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = _ok_run()
        result = build_short(
            source_path=str(source), segment=_segment(tmp_path),
            output_dir=str(tmp_path), video_id="abc123", index=0,
        )

    assert result.endswith("abc123_short0.mp4")
    filters = " ".join(
        cmd[cmd.index("-filter_complex") + 1]
        for cmd in _commands(mock_run) if "-filter_complex" in cmd
    )
    assert f"scale={SHORT_WIDTH}:{SHORT_HEIGHT}" in filters
    assert f"scale={LONG_WIDTH}:{LONG_HEIGHT}" not in filters


def test_short_fills_the_screen_by_cropping(tmp_path):
    """Tela cheia dá mais presença ao creator que a faixa central desfocada."""
    source = tmp_path / "source.mp4"
    source.touch()

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = _ok_run()
        build_short(
            source_path=str(source), segment=_segment(tmp_path),
            output_dir=str(tmp_path), video_id="abc123", index=0,
        )

    for name in ("_short0_narration.mp4", "_short0_clip.mp4"):
        cmd = next(c for c in _commands(mock_run) if name in c[-1])
        f = cmd[cmd.index("-filter_complex") + 1]
        assert f"crop={SHORT_WIDTH}:{SHORT_HEIGHT}" in f
        assert "boxblur" not in f
        assert "overlay" not in f


def test_long_video_still_pads_instead_of_cropping(tmp_path):
    """No 16:9 o corte perderia enquadramento; o fundo desfocado fica."""
    source = tmp_path / "source.mp4"
    source.touch()

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = _ok_run()
        build_long_video(
            source_path=str(source), segments=[_segment(tmp_path)],
            output_dir=str(tmp_path), video_id="abc123",
        )

    cmd = next(c for c in _commands(mock_run) if "_long_0_clip.mp4" in c[-1])
    f = cmd[cmd.index("-filter_complex") + 1]
    assert "boxblur" in f
    assert "overlay" in f


def test_blur_background_uses_even_dimensions(tmp_path):
    """1080 // 8 = 135, ímpar; dimensão ímpar em yuv420p depende de build."""
    source = tmp_path / "source.mp4"
    source.touch()

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = _ok_run()
        build_long_video(
            source_path=str(source), segments=[_segment(tmp_path)],
            output_dir=str(tmp_path), video_id="abc123",
        )

    cmd = next(c for c in _commands(mock_run) if "_long_0_clip.mp4" in c[-1])
    f = cmd[cmd.index("-filter_complex") + 1]
    assert "scale=240:134:" in f


def test_short_clip_is_capped_to_stay_a_short(tmp_path):
    """
    Acima de 3 min o arquivo vertical deixa de ser Short e vira vídeo vertical
    comum no feed principal — pior que as duas opções.
    """
    source = tmp_path / "source.mp4"
    source.touch()
    segment = _segment(tmp_path, start=10.0, end=310.0)  # 300s de clipe

    with (
        patch("pipeline.editor.subprocess.run") as mock_run,
        patch("pipeline.editor.probe_duration", return_value=45.0),
    ):
        mock_run.return_value = _ok_run()
        build_short(
            source_path=str(source), segment=segment,
            output_dir=str(tmp_path), video_id="abc123", index=0,
        )

    clip_cmd = next(c for c in _commands(mock_run) if "_short0_clip.mp4" in c[-1])
    clip_seconds = float(clip_cmd[clip_cmd.index("-t") + 1])
    assert clip_seconds == SHORT_MAX_SECONDS - 45.0
    assert 45.0 + clip_seconds <= SHORT_MAX_SECONDS


def test_short_keeps_clip_intact_when_it_already_fits(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    segment = _segment(tmp_path, start=10.0, end=80.0)  # 70s

    with (
        patch("pipeline.editor.subprocess.run") as mock_run,
        patch("pipeline.editor.probe_duration", return_value=40.0),
    ):
        mock_run.return_value = _ok_run()
        build_short(
            source_path=str(source), segment=segment,
            output_dir=str(tmp_path), video_id="abc123", index=0,
        )

    clip_cmd = next(c for c in _commands(mock_run) if "_short0_clip.mp4" in c[-1])
    assert float(clip_cmd[clip_cmd.index("-t") + 1]) == 70.0


def test_short_rejects_narration_that_leaves_no_room(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()

    with (
        patch("pipeline.editor.subprocess.run") as mock_run,
        patch("pipeline.editor.probe_duration", return_value=170.0),
    ):
        mock_run.return_value = _ok_run()
        with pytest.raises(RuntimeError, match="não deixa espaço"):
            build_short(
                source_path=str(source), segment=_segment(tmp_path),
                output_dir=str(tmp_path), video_id="abc123", index=0,
            )


def test_has_audio_stream_raises_when_ffprobe_fails(tmp_path):
    """ffprobe quebrado não pode ser lido como 'asset sem áudio'."""
    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="boom")
        with pytest.raises(RuntimeError, match="ffprobe falhou"):
            real_has_audio_stream(str(tmp_path / "outro.mp4"))


def test_clip_segment_keeps_original_audio(tmp_path):
    """O clipe do creator precisa manter a voz dele, não a narração da IA."""
    source = tmp_path / "source.mp4"
    source.touch()

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = _ok_run()
        build_long_video(
            source_path=str(source), segments=[_segment(tmp_path)],
            output_dir=str(tmp_path), video_id="abc123",
        )

    clip_cmd = next(c for c in _commands(mock_run) if "_long_0_clip.mp4" in c[-1])
    # 0:a:0, não 0:a — dublagem automática do YouTube vira 2ª trilha e o concat
    # com -c copy exige a mesma contagem de streams em todos os segmentos.
    assert "0:a:0" in clip_cmd
    assert "0:a" not in clip_cmd
    assert "-noautorotate" in clip_cmd


def test_narration_segment_maps_single_audio_stream(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = _ok_run()
        build_long_video(
            source_path=str(source), segments=[_segment(tmp_path)],
            output_dir=str(tmp_path), video_id="abc123",
        )

    cmd = next(c for c in _commands(mock_run) if "_long_0_narration.mp4" in c[-1])
    assert "1:a:0" in cmd


def test_narration_segment_caps_duration(tmp_path):
    """-stream_loop -1 sem teto rodaria até o timeout se a narração vier vazia."""
    source = tmp_path / "source.mp4"
    source.touch()

    with (
        patch("pipeline.editor.subprocess.run") as mock_run,
        patch("pipeline.editor.probe_duration", return_value=42.5),
    ):
        mock_run.return_value = _ok_run()
        build_long_video(
            source_path=str(source), segments=[_segment(tmp_path)],
            output_dir=str(tmp_path), video_id="abc123",
        )

    cmd = next(c for c in _commands(mock_run) if "_long_0_narration.mp4" in c[-1])
    assert cmd[cmd.index("-t") + 1] == "42.5"


def test_narration_segment_rejects_empty_narration(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()

    with (
        patch("pipeline.editor.subprocess.run") as mock_run,
        patch("pipeline.editor.probe_duration", return_value=0.0),
    ):
        mock_run.return_value = _ok_run()
        with pytest.raises(RuntimeError, match="Narração ilegível"):
            build_long_video(
                source_path=str(source), segments=[_segment(tmp_path)],
                output_dir=str(tmp_path), video_id="abc123",
            )


def test_asset_with_audio_keeps_its_own_track(tmp_path):
    """Mapear anullsrc por cima deixaria todo vídeo terminar em silêncio."""
    source = tmp_path / "source.mp4"
    source.touch()
    outro = tmp_path / "outro.mp4"
    outro.touch()

    with (
        patch("pipeline.editor.subprocess.run") as mock_run,
        patch("pipeline.editor.has_audio_stream", return_value=True),
    ):
        mock_run.return_value = _ok_run()
        build_long_video(
            source_path=str(source), segments=[_segment(tmp_path)],
            output_dir=str(tmp_path), video_id="abc123", outro_path=str(outro),
        )

    cmd = next(c for c in _commands(mock_run) if "_long_outro.mp4" in c[-1])
    assert "0:a:0" in cmd
    assert "anullsrc" not in " ".join(cmd)


def test_asset_without_audio_gets_silent_track(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()
    outro = tmp_path / "outro.mp4"
    outro.touch()

    with (
        patch("pipeline.editor.subprocess.run") as mock_run,
        patch("pipeline.editor.has_audio_stream", return_value=False),
    ):
        mock_run.return_value = _ok_run()
        build_long_video(
            source_path=str(source), segments=[_segment(tmp_path)],
            output_dir=str(tmp_path), video_id="abc123", outro_path=str(outro),
        )

    cmd = next(c for c in _commands(mock_run) if "_long_outro.mp4" in c[-1])
    assert "anullsrc=r=44100:cl=stereo" in cmd


def test_build_raises_on_ffmpeg_failure(tmp_path):
    source = tmp_path / "source.mp4"
    source.touch()

    with patch("pipeline.editor.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stderr="boom")
        with pytest.raises(RuntimeError, match="ffmpeg falhou"):
            build_long_video(
                source_path=str(source), segments=[_segment(tmp_path)],
                output_dir=str(tmp_path), video_id="abc123",
            )
