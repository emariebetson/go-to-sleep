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
};

const initialData: StudioData = {
  childName: "",
  ageMonths: "6",
  challenge: "settling",
  theme: "moonlit-meadow",
  duration: "10",
  sound: "soft-rain",
  style: "slow-story",
  scriptMode: "personalized",
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
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const generationRequestRef = useRef("");

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

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
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined });
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        setVoiceBlob(new Blob(chunksRef.current, { type: recorder.mimeType }));
        stream.getTracks().forEach((track) => track.stop());
      };
      recorderRef.current = recorder;
      setSeconds(0);
      recorder.start(1000);
      setRecording(true);
    } catch {
      setMessage("Microphone access was not available. Check browser permissions, then try again.");
    }
  }

  async function createVoice() {
    if (!consented || !voiceBlob) return;
    setBusy(true); setMessage("");
    const form = new FormData();
    form.append("sample", voiceBlob, "parent-voice.webm");
    form.append("name", `${data.childName || "Baby"}'s parent`);
    form.append("consent", "true");
    try {
      const response = await fetch("/api/voices", { method: "POST", body: form });
      const payload = await response.json() as { voiceId?: string; error?: string };
      if (!response.ok || !payload.voiceId) throw new Error(payload.error || "Voice setup could not be completed.");
      setVoiceId(payload.voiceId);
      setStep(3);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Voice setup could not be completed.");
    } finally { setBusy(false); }
  }

  async function createScript() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/scripts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const payload = await response.json() as { script?: string; error?: string };
      if (!response.ok || !payload.script) throw new Error(payload.error || "The story could not be written.");
      setScript(payload.script);
      setStep(4);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The story could not be written.");
    } finally { setBusy(false); }
  }

  async function createAudio() {
    setBusy(true); setMessage("");
    let responseReceived = false;
    generationRequestRef.current ||= crypto.randomUUID();
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...data, script, voiceId, requestId: generationRequestRef.current }),
      });
      responseReceived = true;
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error || "The audio could not be generated.");
      }
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = await response.json() as { audioUrl: string };
        setAudioUrl(payload.audioUrl);
      } else {
        setAudioUrl(URL.createObjectURL(await response.blob()));
      }
      generationRequestRef.current = "";
    } catch (error) {
      if (responseReceived) generationRequestRef.current = "";
      setMessage(error instanceof Error ? error.message : "The audio could not be generated.");
    } finally { setBusy(false); }
  }

  return (
    <>
      <span className="eyebrow">Tonight’s sleep recipe</span>
      <h1 className="app-title display">Create a gentler bedtime</h1>
      <p className="muted">About four minutes to make. Yours to replay whenever you need it.</p>
      <div className="progress" aria-label={`Step ${step} of 4`}>{[1,2,3,4].map((value) => <span className={value <= step ? "done" : ""} key={value} />)}</div>

      {step === 1 && <section className="panel">
        <h2>First, tell us about tonight</h2><p className="panel-intro">Use a nickname only. We don’t need your baby’s full name or birth date.</p>
        <div className="form-grid">
          <div className="field"><label htmlFor="childName">Baby’s nickname</label><input id="childName" maxLength={32} value={data.childName} onChange={(e) => update("childName", e.target.value)} placeholder="Junie" autoComplete="off" /></div>
          <div className="field"><label htmlFor="ageMonths">Age in months</label><input id="ageMonths" min="0" max="24" inputMode="numeric" type="number" value={data.ageMonths} onChange={(e) => update("ageMonths", e.target.value)} /></div>
          <div className="field"><label htmlFor="challenge">What feels hardest tonight?</label><select id="challenge" value={data.challenge} onChange={(e) => update("challenge", e.target.value)}><option value="settling">Settling at bedtime</option><option value="frequent-waking">Frequent waking</option><option value="separation">Parent separation</option><option value="overtired">Overtired or fussy</option><option value="nap-transition">Nap transition</option></select></div>
          <div className="field"><label htmlFor="duration">Session length</label><select id="duration" value={data.duration} onChange={(e) => update("duration", e.target.value)}><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="15">15 minutes</option><option value="20">20 minutes</option></select></div>
          <ChoiceGroup label="Story world" type="theme" value={data.theme} onChange={(value) => update("theme", value)} />
        </div>
        <div className="panel-actions"><span /><button className="btn btn-primary" disabled={!data.childName.trim()} onClick={() => setStep(2)}>Continue to your voice →</button></div>
      </section>}

      {step === 2 && <section className="panel">
        <h2>Add the voice they know</h2><p className="panel-intro">Read naturally for 60–120 seconds in a quiet room. We send this sample directly to ElevenLabs and do not keep the raw recording.</p>
        <div className="record-box">
          <button className={`record-pulse ${recording ? "live" : ""}`} onClick={toggleRecording} aria-label={recording ? "Stop recording" : "Start recording"}>{recording ? "■" : "●"}</button>
          <div className="record-time">{formatSeconds(seconds)}</div>
          <p className="muted" style={{ margin: "5px 0 0" }}>{voiceBlob ? "Recording ready. You can record again if you’d like." : "Tap to record a calm sample of your voice."}</p>
        </div>
        <p style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>Try reading: “The moon is rising, the room is quiet, and everything can soften now. We are safe and close together.” Continue with any calm text.</p>
        <label className="consent-box"><input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} /><span><strong>I confirm this is my voice and I consent to creating a voice clone.</strong><br />I understand generated audio can say words I did not record, and I can permanently delete the clone at any time.</span></label>
        {message && <div className="alert" role="alert">{message}</div>}
        <div className="panel-actions"><button className="btn btn-secondary" onClick={() => setStep(1)}>← Back</button><button className="btn btn-primary" onClick={createVoice} disabled={!voiceBlob || !consented || busy}>{busy ? "Creating your voice…" : "Use this recording →"}</button></div>
      </section>}

      {step === 3 && <section className="panel">
        <h2>Set the feeling</h2><p className="panel-intro">Choose a writing mode and the way your voice should settle into the room.</p>
        <div className="form-grid">
          <fieldset className="field full choice-field"><legend>Story writing</legend><div className="choice-grid"><label className={`choice ${data.scriptMode === "personalized" ? "selected" : ""}`}><input type="radio" name="scriptMode" value="personalized" checked={data.scriptMode === "personalized"} onChange={() => update("scriptMode", "personalized")} /><strong>Personalized</strong><small>AI-written within baby-safe guardrails</small></label><label className={`choice ${data.scriptMode === "curated" ? "selected" : ""}`}><input type="radio" name="scriptMode" value="curated" checked={data.scriptMode === "curated"} onChange={() => update("scriptMode", "curated")} /><strong>Curated</strong><small>A reviewed, predictable template</small></label></div></fieldset>
          <ChoiceGroup label="Settling style" type="style" value={data.style} onChange={(value) => update("style", value)} />
          <ChoiceGroup label="Background sound" type="sound" value={data.sound} onChange={(value) => update("sound", value)} />
        </div>
        {message && <div className="alert" role="alert">{message}</div>}
        <div className="panel-actions"><button className="btn btn-secondary" onClick={() => setStep(2)}>← Back</button><button className="btn btn-primary" onClick={createScript} disabled={busy}>{busy ? "Writing softly…" : "Write tonight’s story →"}</button></div>
      </section>}

      {step === 4 && <section className="panel">
        <h2>Review before your voice reads it</h2><p className="panel-intro">You have final say. Edit anything that doesn’t sound like you.</p>
        <div className="field"><label htmlFor="script">Tonight’s script</label><textarea id="script" style={{ minHeight: 310, lineHeight: 1.75 }} value={script} onChange={(e) => { setScript(e.target.value); generationRequestRef.current = ""; }} /></div>
        {audioUrl && <div className="alert success"><strong>Your bedtime is ready.</strong><div style={{ marginTop: 10 }}><SleepPlayer src={audioUrl} sound={data.sound} /></div></div>}
        {message && <div className="alert" role="alert">{message}</div>}
        <div className="panel-actions"><button className="btn btn-secondary" onClick={() => setStep(3)}>← Adjust</button><button className="btn btn-primary" onClick={createAudio} disabled={!script.trim() || busy}>{busy ? "Creating the audio…" : "Create the audio →"}</button></div>
      </section>}
    </>
  );
}
