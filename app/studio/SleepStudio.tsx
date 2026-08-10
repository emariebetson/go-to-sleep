"use client";

import { useEffect, useRef, useState } from "react";
import { SleepPlayer } from "@/components/SleepPlayer";

type StudioData = {
  childName: string;
  ageMonths: string;
  challenge: string;
  theme: string;
  duration: string;
  sound: string;
  style: string;
  scriptMode: "curated" | "personalized";
  contentType: "story" | "sleep-hypnosis";
  sourceUrl: string;
};

type SourceMetadata = { url: string; title: string; creator: string };
type BusyAction = "" | "voice" | "script" | "preview" | "save";
const MIN_RECORDING_SECONDS = 60;

const initialData: StudioData = {
  childName: "",
  ageMonths: "6",
  challenge: "settling",
  theme: "moonlit-meadow",
  duration: "10",
  sound: "soft-rain",
  style: "slow-story",
  scriptMode: "personalized",
  contentType: "story",
  sourceUrl: "",
};

const choices = {
  theme: [
    ["moonlit-meadow", "Moonlit meadow", "Quiet fireflies and warm grass"],
    ["sleepy-sea", "Sleepy sea", "Gentle waves and a tiny boat"],
    ["cloud-garden", "Cloud garden", "Soft clouds and floating flowers"],
  ],
  sound: [
    ["soft-rain", "Soft rain", "Light, steady rainfall"],
    ["brown-noise", "Brown noise", "Deep, even hush"],
    ["none", "Voice only", "No background layer"],
  ],
  style: [
    ["slow-story", "Slow story", "Warm, gentle narration"],
    ["rhythmic", "Rhythmic settling", "Repetition and long pauses"],
    ["lullaby", "Lullaby-like", "Softly musical phrasing"],
  ],
} as const;

type ChoiceType = keyof typeof choices;

function ChoiceGroup({ label, type, value, onChange }: {
  label: string;
  type: ChoiceType;
  value: string;
  onChange: (value: string) => void;
}) {
  return <fieldset className="field full choice-field">
    <legend>{label}</legend>
    <div className="choice-grid">{choices[type].map(([choiceValue, choiceLabel, detail]) => (
      <label className={`choice ${value === choiceValue ? "selected" : ""}`} key={choiceValue}>
        <input type="radio" name={type} value={choiceValue} checked={value === choiceValue} onChange={() => onChange(choiceValue)} />
        <strong>{choiceLabel}</strong><small>{detail}</small>
      </label>
    ))}</div>
  </fieldset>;
}

function formatSeconds(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function SleepStudio() {
  const [step, setStep] = useState(1);
  const [data, setData] = useState<StudioData>(initialData);
  const [consented, setConsented] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [savedVoiceName, setSavedVoiceName] = useState("");
  const [script, setScript] = useState("");
  const [source, setSource] = useState<SourceMetadata | null>(null);
  const [busy, setBusy] = useState<BusyAction>("");
  const [message, setMessage] = useState("");
  const [previewAudioUrl, setPreviewAudioUrl] = useState("");
  const [savedAudioUrl, setSavedAudioUrl] = useState("");
  const [savedSessionId, setSavedSessionId] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStartedAtRef = useRef(0);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingSecondsRef = useRef(0);
  const generationRequestRef = useRef("");

  useEffect(() => {
    let active = true;
    fetch("/api/voices", { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? response.json() as Promise<{ voice?: { voiceId: string; name: string } | null }> : null)
      .then((payload) => {
        if (!active || !payload?.voice) return;
        setVoiceId(payload.voice.voiceId);
        setSavedVoiceName(payload.voice.name);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      recordingSecondsRef.current = Math.floor((Date.now() - recordingStartedAtRef.current) / 1000);
      setSeconds(recordingSecondsRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (previewAudioUrl.startsWith("blob:")) URL.revokeObjectURL(previewAudioUrl);
    if (savedAudioUrl.startsWith("blob:")) URL.revokeObjectURL(savedAudioUrl);
  }, [previewAudioUrl, savedAudioUrl]);

  function clearGeneratedAudio() {
    if (previewAudioUrl.startsWith("blob:")) URL.revokeObjectURL(previewAudioUrl);
    if (savedAudioUrl.startsWith("blob:")) URL.revokeObjectURL(savedAudioUrl);
    setPreviewAudioUrl("");
    setSavedAudioUrl("");
    setSavedSessionId("");
    generationRequestRef.current = "";
  }

  function update<K extends keyof StudioData>(key: K, value: StudioData[K]) {
    setData((current) => ({ ...current, [key]: value }));
  }

  async function toggleRecording() {
    setMessage("");
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      setVoiceBlob(null);
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined });
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const elapsedSeconds = Math.floor((Date.now() - recordingStartedAtRef.current) / 1000);
        recordingSecondsRef.current = elapsedSeconds;
        setSeconds(elapsedSeconds);
        if (elapsedSeconds < MIN_RECORDING_SECONDS || blob.size < 10_000) {
          setVoiceBlob(null);
          setMessage(`Please record at least ${MIN_RECORDING_SECONDS} seconds so the voice sample is clear enough.`);
        } else {
          setVoiceBlob(blob);
        }
        stream.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
      };
      recorderRef.current = recorder;
      recordingStreamRef.current = stream;
      recordingStartedAtRef.current = Date.now();
      recordingSecondsRef.current = 0;
      setSeconds(0);
      recorder.start(1000);
      setRecording(true);
    } catch {
      setMessage("Microphone access was not available. Check browser permissions, then try again.");
    }
  }

  async function createVoice() {
    if (!consented || !voiceBlob) return;
    setBusy("voice"); setMessage("");
    const form = new FormData();
    form.append("sample", voiceBlob, "parent-voice.webm");
    form.append("name", `${data.childName || "Baby"}'s parent`);
    form.append("consent", "true");
    try {
      const response = await fetch("/api/voices", { method: "POST", body: form });
      const payload = await response.json() as { voiceId?: string; error?: string };
      if (!response.ok || !payload.voiceId) throw new Error(payload.error || "Voice setup could not be completed.");
      setVoiceId(payload.voiceId);
      setSavedVoiceName(`${data.childName || "Baby"}'s parent`);
      setStep(3);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Voice setup could not be completed.");
    } finally { setBusy(""); }
  }

  async function createScript() {
    setBusy("script"); setMessage(""); clearGeneratedAudio();
    try {
      const response = await fetch("/api/scripts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const payload = await response.json() as { script?: string; source?: SourceMetadata | null; error?: string };
      if (!response.ok || !payload.script) throw new Error(payload.error || "The bedtime could not be written.");
      setScript(payload.script);
      setSource(payload.source || null);
      setStep(4);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The bedtime could not be written.");
    } finally { setBusy(""); }
  }

  async function createAudio(generationMode: "preview" | "save") {
    setBusy(generationMode); setMessage("");
    if (generationMode === "save") generationRequestRef.current ||= crypto.randomUUID();
    const requestId = generationMode === "save" ? generationRequestRef.current : crypto.randomUUID();
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...data,
          script,
          voiceId,
          requestId,
          generationMode,
          sourceUrl: source?.url || "",
          sourceTitle: source?.title || "",
        }),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || "The audio could not be generated.");
      }
      if (generationMode === "preview") {
        if (previewAudioUrl.startsWith("blob:")) URL.revokeObjectURL(previewAudioUrl);
        setPreviewAudioUrl(URL.createObjectURL(await response.blob()));
        return;
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = await response.json() as { audioUrl: string; sessionId: string };
        setSavedAudioUrl(payload.audioUrl);
        setSavedSessionId(payload.sessionId);
      } else {
        setSavedAudioUrl(URL.createObjectURL(await response.blob()));
        setSavedSessionId(requestId);
      }
      generationRequestRef.current = "";
    } catch (error) {
      if (generationMode === "save") generationRequestRef.current = "";
      setMessage(error instanceof Error ? error.message : "The audio could not be generated.");
    } finally { setBusy(""); }
  }

  return (
    <>
      <span className="eyebrow">Tonight’s sleep recipe</span>
      <h1 className="app-title display">Create a gentler bedtime</h1>
      <p className="muted">Clone your voice, shape an original bedtime, preview 30 seconds, then save it to My nights.</p>
      <div className="progress" aria-label={`Step ${step} of 4`}>{[1,2,3,4].map((value) => <span className={value <= step ? "done" : ""} key={value} />)}</div>

      {step === 1 && <section className="panel">
        <h2>First, tell us about tonight</h2><p className="panel-intro">Use a nickname only. We don’t need your baby’s full name or birth date.</p>
        <div className="form-grid">
          <div className="field"><label htmlFor="childName">Baby’s nickname</label><input id="childName" maxLength={32} value={data.childName} onChange={(event) => update("childName", event.target.value)} placeholder="Junie" autoComplete="off" /></div>
          <div className="field"><label htmlFor="ageMonths">Age in months</label><input id="ageMonths" min="0" max="24" inputMode="numeric" type="number" value={data.ageMonths} onChange={(event) => update("ageMonths", event.target.value)} /></div>
          <div className="field"><label htmlFor="challenge">What feels hardest tonight?</label><select id="challenge" value={data.challenge} onChange={(event) => update("challenge", event.target.value)}><option value="settling">Settling at bedtime</option><option value="frequent-waking">Frequent waking</option><option value="separation">Parent separation</option><option value="overtired">Overtired or fussy</option><option value="nap-transition">Nap transition</option></select></div>
          <div className="field"><label htmlFor="duration">Session length</label><select id="duration" value={data.duration} onChange={(event) => update("duration", event.target.value)}><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="15">15 minutes</option><option value="20">20 minutes</option></select></div>
          <ChoiceGroup label="Story world" type="theme" value={data.theme} onChange={(value) => update("theme", value)} />
        </div>
        <div className="panel-actions"><span /><button className="btn btn-primary" disabled={!data.childName.trim()} onClick={() => setStep(2)}>Continue to your voice →</button></div>
      </section>}

      {step === 2 && <section className="panel">
        <h2>Add the voice they know</h2><p className="panel-intro">Read naturally for 60–120 seconds in a quiet room. We send this sample directly to ElevenLabs and do not keep the raw recording.</p>
        {voiceId && <div className="alert success"><strong>Saved voice ready: {savedVoiceName || "Parent voice"}</strong><p style={{ margin: "5px 0 0" }}>Reuse this private clone, or delete it from Account before making a replacement.</p><button className="btn btn-primary btn-small" style={{ marginTop: 12 }} onClick={() => setStep(3)}>Use saved voice →</button></div>}
        {!voiceId && <>
          <div className="record-box">
            <button className={`record-pulse ${recording ? "live" : ""}`} onClick={toggleRecording} aria-label={recording ? "Stop recording" : "Start recording"}>{recording ? "■" : "●"}</button>
            <div className="record-time">{formatSeconds(seconds)}</div>
            <p className="muted" style={{ margin: "5px 0 0" }}>{voiceBlob ? "Recording ready. You can record again if you’d like." : recording ? `Keep reading until at least ${formatSeconds(MIN_RECORDING_SECONDS)}.` : "Tap to record a calm sample of your voice."}</p>
          </div>
          <p style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>Try reading: “The moon is rising, the room is quiet, and everything can soften now. We are safe and close together.” Continue with any calm text.</p>
          <label className="consent-box"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} /><span><strong>I confirm this is my voice and I consent to creating a voice clone.</strong><br />I understand generated audio can say words I did not record, and I can permanently delete the clone at any time.</span></label>
        </>}
        {message && <div className="alert" role="alert">{message}</div>}
        <div className="panel-actions"><button className="btn btn-secondary" onClick={() => setStep(1)} disabled={recording}>← Back</button>{!voiceId && <button className="btn btn-primary" onClick={createVoice} disabled={recording || !voiceBlob || !consented || Boolean(busy)}>{busy === "voice" ? "Creating your voice…" : "Use this recording →"}</button>}</div>
      </section>}

      {step === 3 && <section className="panel">
        <h2>Choose what your voice will read</h2><p className="panel-intro">Make an original story or a gentle, non-clinical guided relaxation. You may add a YouTube link for high-level inspiration.</p>
        <div className="form-grid">
          <fieldset className="field full choice-field"><legend>Bedtime type</legend><div className="choice-grid choice-grid-two">
            <label className={`choice ${data.contentType === "story" ? "selected" : ""}`}><input type="radio" name="contentType" value="story" checked={data.contentType === "story"} onChange={() => update("contentType", "story")} /><strong>Bedtime story</strong><small>Original characters and a quiet story arc</small></label>
            <label className={`choice ${data.contentType === "sleep-hypnosis" ? "selected" : ""}`}><input type="radio" name="contentType" value="sleep-hypnosis" checked={data.contentType === "sleep-hypnosis"} onChange={() => update("contentType", "sleep-hypnosis")} /><strong>Sleep hypnosis</strong><small>Non-clinical guided relaxation; no treatment or sleep claims</small></label>
          </div></fieldset>
          <fieldset className="field full choice-field"><legend>Writing mode</legend><div className="choice-grid choice-grid-two">
            <label className={`choice ${data.scriptMode === "personalized" ? "selected" : ""}`}><input type="radio" name="scriptMode" value="personalized" checked={data.scriptMode === "personalized"} onChange={() => update("scriptMode", "personalized")} /><strong>Personalized</strong><small>AI-written within baby-safe guardrails</small></label>
            <label className={`choice ${data.scriptMode === "curated" ? "selected" : ""}`}><input type="radio" name="scriptMode" value="curated" checked={data.scriptMode === "curated"} onChange={() => update("scriptMode", "curated")} /><strong>Curated</strong><small>A reviewed, predictable template</small></label>
          </div></fieldset>
          <div className="field full"><label htmlFor="sourceUrl">YouTube inspiration (optional)</label><input id="sourceUrl" type="url" inputMode="url" value={data.sourceUrl} onChange={(event) => setData((current) => ({ ...current, sourceUrl: event.target.value, scriptMode: event.target.value.trim() ? "personalized" : current.scriptMode }))} placeholder="https://www.youtube.com/watch?v=…" /><small>We use only the public video title and channel as inspiration. Nearnight does not copy or transcribe the video.</small></div>
          <ChoiceGroup label="Narration style" type="style" value={data.style} onChange={(value) => update("style", value)} />
          <ChoiceGroup label="Background sound" type="sound" value={data.sound} onChange={(value) => update("sound", value)} />
        </div>
        {message && <div className="alert" role="alert">{message}</div>}
        <div className="panel-actions"><button className="btn btn-secondary" onClick={() => setStep(2)}>← Back</button><button className="btn btn-primary" onClick={createScript} disabled={Boolean(busy)}>{busy === "script" ? "Writing softly…" : "Write this bedtime →"}</button></div>
      </section>}

      {step === 4 && <section className="panel">
        <h2>Review, preview, then save</h2><p className="panel-intro">You have final say. Edit anything that doesn’t sound like you, then listen to a 30-second sample before generating the full bedtime.</p>
        {source && <div className="source-note"><strong>Inspired by:</strong> {source.title}{source.creator ? ` · ${source.creator}` : ""}<br /><small>Original wording generated from title/channel metadata only.</small></div>}
        <div className="field"><label htmlFor="script">Tonight’s script</label><textarea id="script" style={{ minHeight: 310, lineHeight: 1.75 }} value={script} onChange={(event) => { setScript(event.target.value); clearGeneratedAudio(); }} /></div>
        {previewAudioUrl && !savedAudioUrl && <div className="alert success"><strong>Your 30-second voice sample is ready.</strong><div style={{ marginTop: 10 }}><SleepPlayer src={previewAudioUrl} sound={data.sound} /></div><p style={{ margin: "9px 0 0" }}>If it sounds right, save the full bedtime below.</p></div>}
        {savedAudioUrl && <div className="alert success"><strong>Your full bedtime is saved to My nights.</strong><div style={{ marginTop: 10 }}><SleepPlayer src={savedAudioUrl} sound={data.sound} /></div><div style={{ marginTop: 12 }}><a className="btn btn-primary btn-small" href="/library">Open My nights →</a></div>{savedSessionId && <span className="sr-only">Saved session {savedSessionId}</span>}</div>}
        {message && <div className="alert" role="alert">{message}</div>}
        <div className="panel-actions panel-actions-wrap">
          <button className="btn btn-secondary" onClick={() => setStep(3)}>← Adjust</button>
          <div className="action-pair">
            <button className="btn btn-secondary" onClick={() => createAudio("preview")} disabled={!script.trim() || Boolean(busy) || Boolean(savedAudioUrl)}>{busy === "preview" ? "Creating sample…" : previewAudioUrl ? "Recreate 30-sec sample" : "Create 30-sec sample"}</button>
            <button className="btn btn-primary" onClick={() => createAudio("save")} disabled={!previewAudioUrl || Boolean(busy) || Boolean(savedAudioUrl)}>{busy === "save" ? "Saving full bedtime…" : savedAudioUrl ? "Saved" : "Save full bedtime →"}</button>
          </div>
        </div>
      </section>}
    </>
  );
}
