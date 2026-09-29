import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

type Translate = (zh: string, en: string) => string;
type Props = { src: string; title: string; t: Translate; duration?: number };
let activeAudio: HTMLAudioElement | null = null;
const timestamp = (value: number) =>
  `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;

export function AudioPlayer(props: Props) {
  // A new source has an independent playback lifecycle, including pending play promises.
  return <Player key={props.src} {...props} />;
}
function Player({ src, title, t, duration: expectedDuration = 0 }: Props) {
  const ref = useRef<HTMLAudioElement>(null);
  const request = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(expectedDuration);
  useEffect(() => {
    const audio = ref.current;
    return () => {
      request.current++;
      audio?.pause();
      if (activeAudio === audio) activeAudio = null;
    };
  }, []);
  async function toggle() {
    const audio = ref.current;
    if (!audio) return;
    if (playing || waiting) {
      request.current++;
      audio.pause();
      setPlaying(false);
      setWaiting(false);
      return;
    }
    const version = ++request.current;
    if (activeAudio && activeAudio !== audio) activeAudio.pause();
    activeAudio = audio;
    if (error) audio.load();
    if (audio.ended) audio.currentTime = 0;
    setError(false);
    setWaiting(true);
    try {
      await audio.play();
    } catch (cause) {
      if (version !== request.current) return;
      setWaiting(false);
      setPlaying(false);
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(true);
    }
  }
  function metadata() {
    const value = ref.current?.duration;
    if (value && Number.isFinite(value)) {
      setDuration(value);
      setReady(true);
    }
  }
  return (
    <div className="ui-audio" role="group" aria-label={`${t("試聽", "Preview")}: ${title}`}>
      <audio
        ref={ref}
        src={src}
        preload="none"
        muted={muted}
        onLoadedMetadata={metadata}
        onDurationChange={metadata}
        onPlay={() => {
          if (activeAudio && activeAudio !== ref.current) activeAudio.pause();
          activeAudio = ref.current;
          setPlaying(true);
        }}
        onPlaying={() => {
          setWaiting(false);
          setPlaying(true);
        }}
        onWaiting={() => setWaiting(true)}
        onPause={() => {
          request.current++;
          setPlaying(false);
          setWaiting(false);
        }}
        onEnded={() => {
          setPlaying(false);
          setWaiting(false);
        }}
        onTimeUpdate={() => setTime(ref.current?.currentTime ?? 0)}
        onError={() => {
          setError(true);
          setWaiting(false);
          setPlaying(false);
          setReady(false);
        }}
      />
      <button
        type="button"
        className="ui-audio-play"
        onClick={() => void toggle()}
        aria-label={
          error
            ? t("重新載入音訊", "Retry audio")
            : playing || waiting
              ? t("暫停", "Pause")
              : t("播放", "Play")
        }
      >
        {waiting ? (
          <span className="ui-spinner" aria-hidden="true" />
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {playing ? <path d="M7 5h4v14H7zm6 0h4v14h-4z" /> : <path d="m8 5 11 7-11 7z" />}
          </svg>
        )}
      </button>
      <div className="ui-audio-timeline">
        <input
          className="ui-range"
          type="range"
          min={0}
          max={duration || 1}
          step={0.01}
          value={Math.min(time, duration || 1)}
          disabled={!ready || error}
          aria-label={t("播放進度", "Playback position")}
          aria-valuetext={`${timestamp(time)} / ${timestamp(duration)}`}
          style={{ "--ui-progress": `${duration ? (time / duration) * 100 : 0}%` } as CSSProperties}
          onChange={(event) => {
            if (!ref.current || !ready) return;
            ref.current.currentTime = event.target.valueAsNumber;
            setTime(event.target.valueAsNumber);
          }}
        />
        <div className="ui-audio-time">
          <span>{timestamp(time)}</span>
          <span>{timestamp(duration)}</span>
        </div>
      </div>
      <button
        type="button"
        className="ui-audio-mute"
        aria-pressed={muted}
        aria-label={t("靜音", "Mute")}
        onClick={() => setMuted(!muted)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9h4l5-4v14l-5-4H4z" />
          {muted ? (
            <path d="m17 9 5 6m0-6-5 6" fill="none" stroke="currentColor" strokeWidth="1.8" />
          ) : (
            <path d="M17 8q5 4 0 8" fill="none" stroke="currentColor" strokeWidth="1.8" />
          )}
        </svg>
      </button>
      <span className={error ? "ui-audio-error" : "ui-sr-only"} role="status">
        {error
          ? t("音訊無法載入，請重試。", "Audio could not load. Please retry.")
          : waiting
            ? t("載入音訊中…", "Loading audio…")
            : ""}
      </span>
    </div>
  );
}
