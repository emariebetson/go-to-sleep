"use client";

import { useEffect, useRef, useState } from "react";
import { SleepPlayer } from "@/components/SleepPlayer";
import { SOLFEGGIO_OPTIONS, type SolfeggioFrequency } from "@/lib/frequency-layers";
import { shouldApplyPronunciationGuess } from "@/lib/studio-pronunciation";
import { shouldPreserveGenerationRequest } from "@/lib/studio-generation-retry";
import { loadStudioBootstrap } from "@/lib/studio-bootstrap";

type StudioData = {
  childName: string;
  pronunciation: string;
  ageMonths: string;
  challenge: string;
  theme: string;
  duration: string;
  sound: string;
  frequencies: SolfeggioFrequency[];
  style: string;
  scriptMode: "curated" | "personalized";
  contentType: "story" | "sleep-hypnosis";
  sourceUrl: string;
  sourceRightsAttested: boolean;
};

type SourceMetadata = { url: string; title: string; creator: string };
type BusyAction = "" | "voice" | "script" | "preview" | "save";
type NarrationKind = "parent_clone" | "demo_narrator";
type ChildProfile = { id: string; nickname: string; pronunciation: string; ageMonths: number; bedtimeChallenge: string };
type PublicVoice = { id: string; name: string; status: string; consentStatus: string | null; consentVersion?: string | null; ownedByCurrentUser: boolean };
const SUPPORTED_DURATIONS = [5, 10, 15, 20] as const;
const MIN_RECORDING_SECONDS = 60;
const CURRENT_VERIFIED_CONSENT_VERSION = "voice-v2-live-phrase";

const initialData: StudioData = {
  childName: "",
  pronunciation: "",
  ageMonths: "6",
  challenge: "settling",
  theme: "moonlit-meadow",
  duration: "10",
  sound: "soft-rain",
  frequencies: [],
  style: "slow-story",
  scriptMode: "personalized",
  contentType: "story",
  sourceUrl: "",
  sourceRightsAttested: false,
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

export function SleepStudio({ initialProductionMode }: { initialProductionMode: boolean }) {
  const [step, setStep] = useState(1);
  const [data, setData] = useState<StudioData>(initialData);
  const [consented, setConsented] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [savedVoiceName, setSavedVoiceName] = useState("");
  const [voiceVerified, setVoiceVerified] = useState(false);
  const [narrationKind, setNarrationKind] = useState<NarrationKind>("parent_clone");
  const [demoNarratorEnabled, setDemoNarratorEnabled] = useState(false);
  const [voiceCloneAllowed, setVoiceCloneAllowed] = useState(true);
  const [allowedDurations, setAllowedDurations] = useState<number[]>([...SUPPORTED_DURATIONS]);
  const [script, setScript] = useState("");
  const [source, setSource] = useState<SourceMetadata | null>(null);
  const [busy, setBusy] = useState<BusyAction>("");
  const [message, setMessage] = useState("");
  const [previewAudioUrl, setPreviewAudioUrl] = useState("");
  const [savedAudioUrl, setSavedAudioUrl] = useState("");
  const [savedSessionId, setSavedSessionId] = useState("");
  const [pronunciationStatus, setPronunciationStatus] = useState("");
  const [productionMode, setProductionMode] = useState<boolean | null>(initialProductionMode);
  const [onboardingAccepted, setOnboardingAccepted] = useState(false);
  const [onboardingVersion, setOnboardingVersion] = useState("");
  const [onboardingAttestation, setOnboardingAttestation] = useState("");
  const [onboardingConfirmations, setOnboardingConfirmations] = useState({ adultAccount: false, caregiverResponsibility: false, privateHouseholdUse: false });
  const [children, setChildren] = useState<ChildProfile[]>([]);
  const [householdVoices, setHouseholdVoices] = useState<PublicVoice[]>([]);
  const [childId, setChildId] = useState("");
  const [voiceChallenge, setVoiceChallenge] = useState<{ challengeId: string; phrase: string } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStartedAtRef = useRef(0);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingSecondsRef = useRef(0);
  const generationRequestRef = useRef("");
  const previewRequestRef = useRef("");
  const scriptRequestRef = useRef("");
  const childRequestRef = useRef("");
  const voiceRequestRef = useRef("");
  const challengeRequestRef = useRef("");
  const onboardingRequestRef = useRef("");
  const discardRecordingRef = useRef(false);
  const childNameRef = useRef("");
  const autoPronunciationRef = useRef("");
  const pronunciationManualVersionRef = useRef(0);
  const pronunciationRequestIdRef = useRef(0);
  const pronunciationControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    loadStudioBootstrap(initialProductionMode).then(async ({ onboarding: onboardingResponse, children: childrenResponse, voices: voicesResponse }) => {
      if (onboardingResponse && !onboardingResponse.ok && onboardingResponse.status !== 404) throw new Error("Production mode could not be verified.");
      const onboarding = onboardingResponse?.ok
        ? await onboardingResponse.json() as { accepted?: boolean; version?: string; attestation?: string; productionMode?: boolean }
        : null;
      const live = initialProductionMode;
      if (live && (!childrenResponse?.ok || !voicesResponse.ok)) throw new Error("Selected-household Studio data could not be loaded.");
      const childPayload = childrenResponse?.ok ? await childrenResponse.json() as { children?: ChildProfile[] } : null;
      const voicePayload = voicesResponse.ok ? await voicesResponse.json() as { voice?: { voiceId?: string; name: string } | null; voices?: PublicVoice[]; demoEnabled?: boolean; standardNarratorAvailable?: boolean; voiceCloneAllowed?: boolean; allowedNarrationDurations?: number[] } : null;
      if (!active) return;
      const productionDurations = (voicePayload?.allowedNarrationDurations || []).filter((duration): duration is number => SUPPORTED_DURATIONS.includes(duration as typeof SUPPORTED_DURATIONS[number]));
      if (live && productionDurations.length === 0) throw new Error("Selected-household narration policy could not be loaded.");
      const nextDurations = live ? productionDurations : [...SUPPORTED_DURATIONS];
      setAllowedDurations(nextDurations);
      setData((current) => nextDurations.includes(Number(current.duration)) ? current : { ...current, duration: String(nextDurations[0]) });
      setProductionMode(live);
      setOnboardingAccepted(Boolean(onboarding?.accepted));
      setOnboardingVersion(onboarding?.version || "");
      setOnboardingAttestation(onboarding?.attestation || "");
      setChildren((childPayload?.children || []).filter((child) => Boolean(child?.id && child.nickname)
        && Number.isInteger(child.ageMonths) && child.ageMonths >= 0 && child.ageMonths <= 96));
      const cloneAllowed = live ? voicePayload?.voiceCloneAllowed === true : true;
      const standardNarratorAvailable = Boolean(voicePayload?.standardNarratorAvailable ?? voicePayload?.demoEnabled);
      setVoiceCloneAllowed(cloneAllowed);
      setDemoNarratorEnabled(standardNarratorAvailable);
      if (live && !cloneAllowed && standardNarratorAvailable) {
        setNarrationKind("demo_narrator");
        setVoiceId("");
        setVoiceVerified(false);
        setSavedVoiceName("");
      }
      const publicVoices = live ? (voicePayload?.voices || []) : [];
      setHouseholdVoices(publicVoices);
      const selectedVoice = live && cloneAllowed
        ? publicVoices.find((voice) => voice.ownedByCurrentUser && voice.status === "ready" && voice.consentStatus === "active_verified" && voice.consentVersion === CURRENT_VERIFIED_CONSENT_VERSION)
          || publicVoices.find((voice) => voice.ownedByCurrentUser && voice.status !== "deleted")
        : voicePayload?.voice;
      if (!selectedVoice) return;
      setVoiceId("id" in selectedVoice ? selectedVoice.id : selectedVoice.voiceId || "");
      setSavedVoiceName(selectedVoice.name);
      const verified = !live || ((selectedVoice as PublicVoice).status === "ready"
        && (selectedVoice as PublicVoice).consentStatus === "active_verified"
        && (selectedVoice as PublicVoice).consentVersion === CURRENT_VERIFIED_CONSENT_VERSION);
      setVoiceVerified(verified);
      if (verified) setNarrationKind("parent_clone");
    })
      .catch((error) => {
        if (!active) return;
        setProductionMode(null);
        setMessage(error instanceof Error ? error.message : "Studio mode could not be verified. Refresh before continuing.");
      });
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

  useEffect(() => () => pronunciationControllerRef.current?.abort(), []);

  function clearGeneratedAudio() {
    if (previewAudioUrl.startsWith("blob:")) URL.revokeObjectURL(previewAudioUrl);
    if (savedAudioUrl.startsWith("blob:")) URL.revokeObjectURL(savedAudioUrl);
    setPreviewAudioUrl("");
    setSavedAudioUrl("");
    setSavedSessionId("");
    generationRequestRef.current = "";
    previewRequestRef.current = "";
  }

  function update<K extends keyof StudioData>(key: K, value: StudioData[K]) {
    setData((current) => ({ ...current, [key]: value }));
    scriptRequestRef.current = "";
  }

  function updateChildName(value: string) {
    const clearAutomaticGuess = Boolean(autoPronunciationRef.current) && data.pronunciation === autoPronunciationRef.current;
    childNameRef.current = value;
    pronunciationRequestIdRef.current += 1;
    pronunciationControllerRef.current?.abort();
    pronunciationControllerRef.current = null;
    setPronunciationStatus("");
    if (clearAutomaticGuess) autoPronunciationRef.current = "";
    setData((current) => ({ ...current, childName: value, pronunciation: clearAutomaticGuess ? "" : current.pronunciation }));
    clearGeneratedAudio();
  }

  function updatePronunciation(value: string) {
    pronunciationManualVersionRef.current += 1;
    pronunciationRequestIdRef.current += 1;
    pronunciationControllerRef.current?.abort();
    pronunciationControllerRef.current = null;
    autoPronunciationRef.current = "";
    setPronunciationStatus("");
    update("pronunciation", value);
    clearGeneratedAudio();
  }

  async function guessPronunciation(force = false) {
    const nickname = childNameRef.current.trim() || data.childName.trim();
    if (!nickname) return;
    const hasManualValue = Boolean(data.pronunciation.trim()) && data.pronunciation !== autoPronunciationRef.current;
    if (hasManualValue && !force) return;
    if (force) {
      pronunciationManualVersionRef.current += 1;
      autoPronunciationRef.current = "";
      update("pronunciation", "");
      clearGeneratedAudio();
    }

    pronunciationControllerRef.current?.abort();
    const controller = new AbortController();
    pronunciationControllerRef.current = controller;
    const requestId = ++pronunciationRequestIdRef.current;
    const manualVersion = pronunciationManualVersionRef.current;
    setPronunciationStatus("Finding our best guess…");
    try {
      const response = await fetch("/api/pronunciation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname }),
        signal: controller.signal,
      });
      const payload = await response.json() as { pronunciation?: string; error?: string };
      if (!response.ok || !payload.pronunciation) throw new Error(payload.error || "No guess was available.");
      if (requestId !== pronunciationRequestIdRef.current || !shouldApplyPronunciationGuess(nickname, childNameRef.current, manualVersion, pronunciationManualVersionRef.current)) return;
      autoPronunciationRef.current = payload.pronunciation;
      setData((current) => ({ ...current, pronunciation: payload.pronunciation || "" }));
      setPronunciationStatus("Best guess added. You can edit it before continuing.");
    } catch (error) {
      if (controller.signal.aborted) return;
      setPronunciationStatus(error instanceof Error ? error.message : "Type the pronunciation manually and continue.");
    } finally {
      if (pronunciationControllerRef.current === controller) pronunciationControllerRef.current = null;
    }
  }

  function toggleFrequency(frequency: SolfeggioFrequency) {
    setData((current) => {
      const selected = current.frequencies.includes(frequency);
      if (!selected && current.frequencies.length >= 3) return current;
      return { ...current, frequencies: selected ? current.frequencies.filter((value) => value !== frequency) : [...current.frequencies, frequency] };
    });
    clearGeneratedAudio();
  }

  function selectChildProfile(id: string) {
    setChildId(id);
    const child = children.find((profile) => profile.id === id);
    if (!child) return;
    childNameRef.current = child.nickname;
    setData((current) => ({
      ...current,
      childName: child.nickname,
      pronunciation: child.pronunciation,
      ageMonths: String(child.ageMonths),
      challenge: child.bedtimeChallenge || current.challenge,
    }));
    scriptRequestRef.current = "";
    clearGeneratedAudio();
  }

  function selectHouseholdVoice(id: string) {
    const selected = householdVoices.find((voice) => voice.id === id
      && voice.status === "ready"
      && voice.consentStatus === "active_verified"
      && voice.consentVersion === CURRENT_VERIFIED_CONSENT_VERSION);
    if (!selected) return;
    setVoiceId(selected.id);
    setSavedVoiceName(selected.name);
    setVoiceVerified(true);
    setVoiceChallenge(null);
    setVoiceBlob(null);
    setNarrationKind("parent_clone");
  }

  async function continueFromChild() {
    if (productionMode === null) { setMessage("Studio mode could not be verified. Refresh before continuing."); return; }
    if (!productionMode) { setStep(2); return; }
    setBusy("script"); setMessage("");
    try {
      if (childId) { setStep(2); return; }
      childRequestRef.current ||= crypto.randomUUID();
      const response = await fetch("/api/v1/children", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: childRequestRef.current,
          nickname: data.childName,
          pronunciation: data.pronunciation,
          ageMonths: Number(data.ageMonths),
          bedtimeChallenge: data.challenge,
        }),
      });
      const payload = await response.json() as { child?: ChildProfile; error?: string };
      if (!response.ok || !payload.child) throw new Error(payload.error || "The child profile could not be saved.");
      setChildren((current) => current.some((child) => child.id === payload.child!.id) ? current : [...current, payload.child!]);
      setChildId(payload.child.id);
      childRequestRef.current = "";
      setStep(2);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The child profile could not be saved.");
    } finally { setBusy(""); }
  }

  async function acceptAdultOnboarding() {
    if (!onboardingVersion || !onboardingAttestation || !Object.values(onboardingConfirmations).every(Boolean)) {
      setMessage("Review and confirm every adult caregiver statement before continuing.");
      return;
    }
    setBusy("voice"); setMessage("");
    onboardingRequestRef.current ||= crypto.randomUUID();
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: onboardingRequestRef.current,
          version: onboardingVersion,
          attestation: onboardingAttestation,
          ...onboardingConfirmations,
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Caregiver onboarding could not be recorded.");
      onboardingRequestRef.current = "";
      setOnboardingAccepted(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Caregiver onboarding could not be recorded.");
    } finally { setBusy(""); }
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
      discardRecordingRef.current = false;
      setVoiceBlob(null);
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined });
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const elapsedSeconds = Math.floor((Date.now() - recordingStartedAtRef.current) / 1000);
        recordingSecondsRef.current = elapsedSeconds;
        setSeconds(elapsedSeconds);
        if (discardRecordingRef.current) {
          setVoiceBlob(null);
          chunksRef.current = [];
          discardRecordingRef.current = false;
        } else {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
          if (elapsedSeconds < MIN_RECORDING_SECONDS || blob.size < 10_000) {
            setVoiceBlob(null);
            setMessage(`Please record at least ${MIN_RECORDING_SECONDS} seconds so the voice sample is clear enough.`);
          } else {
            setVoiceBlob(blob);
          }
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
    if (!consented) return;
    setBusy("voice"); setMessage("");
    if (productionMode) {
      try {
        let selectedVoiceId = voiceId;
        if (!selectedVoiceId) {
          voiceRequestRef.current ||= crypto.randomUUID();
          const claimResponse = await fetch("/api/voices", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: voiceRequestRef.current, name: "Parent voice", adultSelfAttestation: true }),
          });
          const claim = await claimResponse.json() as { voiceId?: string; error?: string };
          if (!claimResponse.ok || !claim.voiceId) throw new Error(claim.error || "A household voice slot could not be reserved.");
          selectedVoiceId = claim.voiceId;
          setVoiceId(selectedVoiceId);
          setSavedVoiceName("Parent voice");
          voiceRequestRef.current = "";
        }
        if (!voiceChallenge) {
          challengeRequestRef.current ||= crypto.randomUUID();
          const challengeResponse = await fetch("/api/voices/verification", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: challengeRequestRef.current, voiceId: selectedVoiceId }),
          });
          const challenge = await challengeResponse.json() as { challengeId?: string; phrase?: string; error?: string };
          if (!challengeResponse.ok || !challenge.challengeId || !challenge.phrase) throw new Error(challenge.error || "A live phrase could not be created.");
          setVoiceChallenge({ challengeId: challenge.challengeId, phrase: challenge.phrase });
          setMessage("Read the random phrase shown below during a fresh 60-second recording, then submit it for verification.");
          return;
        }
        if (!voiceBlob) throw new Error("Record the live random phrase before verifying your voice.");
        const verificationForm = new FormData();
        verificationForm.append("challengeId", voiceChallenge.challengeId);
        verificationForm.append("phrase", voiceChallenge.phrase);
        verificationForm.append("sample", voiceBlob, "live-phrase.webm");
        const verifyResponse = await fetch("/api/voices/verification", { method: "POST", body: verificationForm });
        const verified = await verifyResponse.json() as { verified?: boolean; error?: string };
        if (!verifyResponse.ok || !verified.verified) throw new Error(verified.error || "Voice verification could not be completed.");
        challengeRequestRef.current = "";
        setVoiceChallenge(null);
        setVoiceVerified(true);
        setNarrationKind("parent_clone");
        setSavedVoiceName("Parent voice");
        setStep(3);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Voice setup could not be completed.");
      } finally { setBusy(""); }
      return;
    }
    if (!voiceBlob) { setBusy(""); return; }
    const form = new FormData();
    form.append("sample", voiceBlob, "parent-voice.webm");
    form.append("name", `${data.childName || "Baby"}'s parent`);
    form.append("consent", "true");
    try {
      const response = await fetch("/api/voices", { method: "POST", body: form });
      const payload = await response.json() as { voiceId?: string; error?: string; code?: string; demoEnabled?: boolean };
      if (payload.code === "voice_cloning_unavailable" && payload.demoEnabled) setDemoNarratorEnabled(true);
      if (!response.ok || !payload.voiceId) throw new Error(payload.error || "Voice setup could not be completed.");
      setVoiceId(payload.voiceId);
      setVoiceVerified(true);
      setNarrationKind("parent_clone");
      setSavedVoiceName(`${data.childName || "Baby"}'s parent`);
      setStep(3);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Voice setup could not be completed.");
    } finally { setBusy(""); }
  }

  function useDemoNarrator() {
    discardRecordingRef.current = true;
    if (recording) recorderRef.current?.stop();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    setRecording(false);
    setVoiceBlob(null);
    setConsented(false);
    setVoiceId("");
    setVoiceVerified(false);
    setSavedVoiceName("");
    setNarrationKind("demo_narrator");
    setMessage("");
    setStep(3);
  }

  async function createScript() {
    setBusy("script"); setMessage(""); clearGeneratedAudio();
    scriptRequestRef.current ||= crypto.randomUUID();
    try {
      const response = await fetch("/api/scripts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...data, childId, requestId: scriptRequestRef.current }),
      });
      const payload = await response.json() as { script?: string; source?: SourceMetadata | null; notice?: string | null; error?: string; code?: string };
      if (!response.ok || !payload.script) {
        if (!shouldPreserveGenerationRequest(response.status, payload.code)) scriptRequestRef.current = "";
        throw new Error(payload.error || "The bedtime could not be written.");
      }
      scriptRequestRef.current = "";
      setScript(payload.script);
      setSource(payload.source || null);
      setMessage(payload.notice || "");
      setStep(4);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The bedtime could not be written.");
    } finally { setBusy(""); }
  }

  async function createAudio(generationMode: "preview" | "save") {
    setBusy(generationMode); setMessage("");
    if (generationMode === "save") generationRequestRef.current ||= crypto.randomUUID();
    if (generationMode === "preview") previewRequestRef.current ||= crypto.randomUUID();
    const requestId = generationMode === "save" ? generationRequestRef.current : previewRequestRef.current;
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...data,
          childId,
          script,
          voiceId,
          narrationKind,
          requestId,
          generationMode,
          sourceUrl: source?.url || "",
          sourceTitle: source?.title || "",
        }),
      });
      if (!response.ok) {
        const payload = await response.json() as { error?: string; code?: string };
        if (!shouldPreserveGenerationRequest(response.status, payload.code)) {
          if (generationMode === "save") generationRequestRef.current = "";
          else previewRequestRef.current = "";
        }
        throw new Error(payload.error || "The audio could not be generated.");
      }
      const contentType = response.headers.get("content-type") || "";
      if (generationMode === "preview" && !contentType.includes("application/json")) {
        if (previewAudioUrl.startsWith("blob:")) URL.revokeObjectURL(previewAudioUrl);
        setPreviewAudioUrl(URL.createObjectURL(await response.blob()));
        previewRequestRef.current = "";
        return;
      }
      if (contentType.includes("application/json")) {
        const payload = await response.json() as { audioUrl: string; sessionId?: string };
        if (generationMode === "preview") {
          setPreviewAudioUrl(payload.audioUrl);
          previewRequestRef.current = "";
          return;
        }
        setSavedAudioUrl(payload.audioUrl);
        setSavedSessionId(payload.sessionId || requestId);
      } else {
        setSavedAudioUrl(URL.createObjectURL(await response.blob()));
        setSavedSessionId(requestId);
      }
      generationRequestRef.current = "";
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The audio could not be generated.");
    } finally { setBusy(""); }
  }

  return (
    <>
      <span className="eyebrow">Tonight’s sleep recipe</span>
      <h1 className="app-title display">Create a gentler bedtime</h1>
      <p className="muted">{narrationKind === "demo_narrator" ? "Use the standard non-cloned narrator, preview 30 seconds, then save the bedtime to My nights." : "Clone your voice, shape an original bedtime, preview 30 seconds, then save it to My nights."}</p>
      <div className="progress" aria-label={`Step ${step} of 4`}>{[1,2,3,4].map((value) => <span className={value <= step ? "done" : ""} key={value} />)}</div>

      {step === 1 && <section className="panel">
        <h2>First, tell us about tonight</h2><p className="panel-intro">Use a nickname only. We don’t need your baby’s full name or birth date.</p>
        <div className="form-grid">
          {productionMode && <div className="field full"><label htmlFor="childProfile">Child profile</label><select id="childProfile" value={childId} onChange={(event) => selectChildProfile(event.target.value)}><option value="">Create a new child profile</option>{children.map((child) => <option key={child.id} value={child.id}>{child.nickname}</option>)}</select></div>}
          <div className="field"><label htmlFor="childName">Baby’s nickname</label><input id="childName" disabled={Boolean(childId)} maxLength={32} value={data.childName} onChange={(event) => updateChildName(event.target.value)} onBlur={() => void guessPronunciation()} placeholder="Junie" autoComplete="off" /></div>
          <div className="field"><label htmlFor="pronunciation">Pronounced like</label><input id="pronunciation" disabled={Boolean(childId)} maxLength={64} value={data.pronunciation} onChange={(event) => updatePronunciation(event.target.value)} placeholder="LOCK-ee" autoComplete="off" aria-describedby="pronunciation-help pronunciation-status" /><div className="field-helper-row"><small id="pronunciation-help">Type it how it sounds. We use this only for narration.</small><button className="text-button" type="button" disabled={Boolean(childId) || !data.childName.trim() || pronunciationStatus === "Finding our best guess…"} onClick={() => void guessPronunciation(true)}>{data.pronunciation ? "Guess again" : "Make a guess"}</button></div><span className="field-status" id="pronunciation-status" aria-live="polite">{pronunciationStatus}</span></div>
          <div className="field"><label htmlFor="ageMonths">Age in months</label><input id="ageMonths" disabled={Boolean(childId)} min="0" max="96" inputMode="numeric" type="number" value={data.ageMonths} onChange={(event) => update("ageMonths", event.target.value)} /></div>
          <div className="field"><label htmlFor="challenge">What feels hardest tonight?</label><select id="challenge" disabled={Boolean(childId)} value={data.challenge} onChange={(event) => update("challenge", event.target.value)}><option value="settling">Settling at bedtime</option><option value="frequent-waking">Frequent waking</option><option value="separation">Parent separation</option><option value="overtired">Overtired or fussy</option><option value="nap-transition">Nap transition</option></select></div>
          <div className="field"><label htmlFor="duration">Session length</label><select id="duration" value={data.duration} onChange={(event) => update("duration", event.target.value)}>{allowedDurations.map((duration) => <option value={duration} key={duration}>{duration} minutes</option>)}</select></div>
          <ChoiceGroup label="Story world" type="theme" value={data.theme} onChange={(value) => update("theme", value)} />
        </div>
        {message && <div className="alert" role="alert">{message}</div>}
        <div className="panel-actions"><span /><button className="btn btn-primary" disabled={productionMode === null || !data.childName.trim() || Boolean(busy)} onClick={() => void continueFromChild()}>{busy === "script" ? "Saving profile…" : "Continue to your voice →"}</button></div>
      </section>}

      {step === 2 && <section className="panel">
        <h2>{productionMode && !voiceCloneAllowed ? "Choose the standard narrator" : "Add the voice they know"}</h2><p className="panel-intro">{productionMode && !voiceCloneAllowed ? "NearSleep Free uses a standard non-cloned narrator. Your household does not need to record or upload a voice." : productionMode ? "A fresh random phrase verifies adult consent before the recording creates a private voice clone. The raw recording is not retained." : "Read naturally for 60–120 seconds in a quiet room. We send this sample directly to ElevenLabs and do not keep the raw recording."}</p>
        {productionMode === null && <div className="alert" role="alert"><strong>Studio is unavailable until production mode can be verified.</strong><p style={{ margin: "5px 0 0" }}>Refresh before recording or selecting a voice.</p></div>}
        {productionMode && !onboardingAccepted && <div className="consent-box" style={{ display: "block" }}><strong>Adult caregiver confirmation</strong><p>{onboardingAttestation || "The current caregiver statement could not be loaded."}</p>
          <label><input type="checkbox" checked={onboardingConfirmations.adultAccount} onChange={(event) => setOnboardingConfirmations((current) => ({ ...current, adultAccount: event.target.checked }))} /> I confirm I am an adult account holder.</label><br />
          <label><input type="checkbox" checked={onboardingConfirmations.caregiverResponsibility} onChange={(event) => setOnboardingConfirmations((current) => ({ ...current, caregiverResponsibility: event.target.checked }))} /> I accept caregiver responsibility for this household use.</label><br />
          <label><input type="checkbox" checked={onboardingConfirmations.privateHouseholdUse} onChange={(event) => setOnboardingConfirmations((current) => ({ ...current, privateHouseholdUse: event.target.checked }))} /> I will use the voice only for private household narration.</label>
          <div style={{ marginTop: 12 }}><button className="btn btn-primary btn-small" type="button" onClick={() => void acceptAdultOnboarding()} disabled={!onboardingVersion || !onboardingAttestation || !Object.values(onboardingConfirmations).every(Boolean) || Boolean(busy)}>{busy === "voice" ? "Saving confirmation…" : "Accept and continue"}</button></div>
        </div>}
        {productionMode && voiceCloneAllowed && onboardingAccepted && householdVoices.some((voice) => voice.status === "ready" && voice.consentStatus === "active_verified" && voice.consentVersion === CURRENT_VERIFIED_CONSENT_VERSION) && <div className="field full"><label htmlFor="householdVoice">Verified household voice</label><select id="householdVoice" value={voiceVerified ? voiceId : ""} onChange={(event) => selectHouseholdVoice(event.target.value)}><option value="">Set up or re-verify my voice</option>{householdVoices.filter((voice) => voice.status === "ready" && voice.consentStatus === "active_verified" && voice.consentVersion === CURRENT_VERIFIED_CONSENT_VERSION).map((voice) => <option key={voice.id} value={voice.id}>{voice.name}{voice.ownedByCurrentUser ? " (yours)" : ""}</option>)}</select><small>Only local voice names are shown. Provider voice identifiers never leave the server.</small></div>}
        {voiceVerified && <div className="alert success"><strong>Verified voice ready: {savedVoiceName || "Parent voice"}</strong><p style={{ margin: "5px 0 0" }}>Use this selected household voice, or re-verify your own voice when its consent version changes.</p><button className="btn btn-primary btn-small" style={{ marginTop: 12 }} onClick={() => setStep(3)}>Use selected voice →</button></div>}
        {productionMode && voiceCloneAllowed && onboardingAccepted && !voiceVerified && <>
          {voiceChallenge && <div className="alert"><strong>Read this exact random phrase during a fresh recording:</strong><p style={{ fontSize: "1.15rem", marginBottom: 0 }}>{voiceChallenge.phrase}</p></div>}
          {voiceChallenge && <div className="record-box">
            <button className={`record-pulse ${recording ? "live" : ""}`} onClick={toggleRecording} aria-label={recording ? "Stop recording" : "Start live phrase recording"}>{recording ? "■" : "●"}</button>
            <div className="record-time">{formatSeconds(seconds)}</div>
            <p className="muted" style={{ margin: "5px 0 0" }}>{voiceBlob ? "Live-phrase recording ready. You can record it again if needed." : recording ? `Read the displayed phrase, then continue naturally until at least ${formatSeconds(MIN_RECORDING_SECONDS)}.` : "Tap to record the displayed live phrase."}</p>
          </div>}
          <label className="consent-box"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} /><span><strong>I confirm this is my adult voice and I consent to creating this private household voice clone.</strong><br />I understand generated audio can say words I did not record, and I can revoke the clone at any time.</span></label>
        </>}
        {productionMode === false && !voiceVerified && <>
          <div className="record-box">
            <button className={`record-pulse ${recording ? "live" : ""}`} onClick={toggleRecording} aria-label={recording ? "Stop recording" : "Start recording"}>{recording ? "■" : "●"}</button>
            <div className="record-time">{formatSeconds(seconds)}</div>
            <p className="muted" style={{ margin: "5px 0 0" }}>{voiceBlob ? "Recording ready. You can record again if you’d like." : recording ? `Keep reading until at least ${formatSeconds(MIN_RECORDING_SECONDS)}.` : "Tap to record a calm sample of your voice."}</p>
          </div>
          <p style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>Try reading: “The moon is rising, the room is quiet, and everything can soften now. We are safe and close together.” Continue with any calm text.</p>
          <label className="consent-box"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} /><span><strong>I confirm this is my voice and I consent to creating a voice clone.</strong><br />I understand generated audio can say words I did not record, and I can permanently delete the clone at any time.</span></label>
        </>}
        {message && <div className="alert" role="alert">{message}</div>}
        {!voiceVerified && demoNarratorEnabled && <div className="consent-box" style={{ marginTop: 16 }}><span aria-hidden="true">▶</span><span><strong>Standard narrator</strong><br />This narrator is not your voice. No adult recording is uploaded or stored.</span></div>}
        <div className="panel-actions panel-actions-wrap"><button className="btn btn-secondary" onClick={() => setStep(1)} disabled={recording}>← Back</button>{!voiceVerified && onboardingAccepted && productionMode === true && <div className="action-pair">{demoNarratorEnabled && <button className={voiceCloneAllowed ? "btn btn-secondary" : "btn btn-primary"} onClick={useDemoNarrator} disabled={Boolean(busy)}>Use standard narrator →</button>}{voiceCloneAllowed && <button className="btn btn-primary" onClick={createVoice} disabled={recording || !consented || Boolean(busy) || (Boolean(voiceChallenge) && !voiceBlob)}>{busy === "voice" ? "Securing your voice…" : voiceChallenge ? "Verify this live recording →" : "Start secure voice setup →"}</button>}</div>}{!voiceVerified && productionMode === false && <div className="action-pair">{demoNarratorEnabled && <button className="btn btn-secondary" onClick={useDemoNarrator} disabled={Boolean(busy)}>Use standard narrator</button>}<button className="btn btn-primary" onClick={createVoice} disabled={recording || !voiceBlob || !consented || Boolean(busy)}>{busy === "voice" ? "Creating your voice…" : "Use this recording →"}</button></div>}</div>
      </section>}

      {step === 3 && <section className="panel">
        <h2>Choose what {narrationKind === "demo_narrator" ? "the standard narrator" : "your voice"} will read</h2><p className="panel-intro">{narrationKind === "demo_narrator" && <><strong>Standard narrator is active — this is not your voice.</strong><br /></>}Make an original story or a gentle, non-clinical guided relaxation. You may add a YouTube link for high-level inspiration.</p>
        <div className="form-grid">
          <fieldset className="field full choice-field"><legend>Bedtime type</legend><div className="choice-grid choice-grid-two">
            <label className={`choice ${data.contentType === "story" ? "selected" : ""}`}><input type="radio" name="contentType" value="story" checked={data.contentType === "story"} onChange={() => update("contentType", "story")} /><strong>Bedtime story</strong><small>Original characters and a quiet story arc</small></label>
            <label className={`choice ${data.contentType === "sleep-hypnosis" ? "selected" : ""}`}><input type="radio" name="contentType" value="sleep-hypnosis" checked={data.contentType === "sleep-hypnosis"} onChange={() => update("contentType", "sleep-hypnosis")} /><strong>Sleep hypnosis</strong><small>Non-clinical guided relaxation; no treatment or sleep claims</small></label>
          </div></fieldset>
          <fieldset className="field full choice-field"><legend>Writing mode</legend><div className="choice-grid choice-grid-two">
            <label className={`choice ${data.scriptMode === "personalized" ? "selected" : ""}`}><input type="radio" name="scriptMode" value="personalized" checked={data.scriptMode === "personalized"} onChange={() => update("scriptMode", "personalized")} /><strong>Personalized</strong><small>AI-written within baby-safe guardrails</small></label>
            <label className={`choice ${data.scriptMode === "curated" ? "selected" : ""}`}><input type="radio" name="scriptMode" value="curated" checked={data.scriptMode === "curated"} onChange={() => update("scriptMode", "curated")} /><strong>Curated</strong><small>A reviewed, predictable template</small></label>
          </div></fieldset>
          <div className="field full"><label htmlFor="sourceUrl">YouTube inspiration (optional)</label><input id="sourceUrl" type="url" inputMode="url" value={data.sourceUrl} onChange={(event) => setData((current) => ({ ...current, sourceUrl: event.target.value, sourceRightsAttested: false, scriptMode: event.target.value.trim() ? "personalized" : current.scriptMode }))} placeholder="https://www.youtube.com/watch?v=…" /><small>We use only the public title and channel as high-level inspiration. NearSleep never copies, transcribes, or recreates the linked audio.</small>{data.sourceUrl.trim() && <label className="consent-box" style={{ marginTop: 10 }}><input type="checkbox" checked={data.sourceRightsAttested} onChange={(event) => update("sourceRightsAttested", event.target.checked)} /><span>I confirm I own this linked material or have permission to use its public title and channel as creative inspiration.</span></label>}</div>
          <ChoiceGroup label="Narration style" type="style" value={data.style} onChange={(value) => update("style", value)} />
          <ChoiceGroup label="Background sound" type="sound" value={data.sound} onChange={(value) => update("sound", value)} />
          <fieldset className="field full choice-field" aria-describedby="frequency-help"><legend>Solfeggio layers (optional)</legend><div className="frequency-grid">{SOLFEGGIO_OPTIONS.map((option) => {
            const selected = data.frequencies.includes(option.frequency);
            const disabled = !selected && data.frequencies.length >= 3;
            const inputId = `frequency-${option.frequency}`;
            return <label aria-label={`Select ${option.frequency} hertz: ${option.description}`} className={`frequency-choice ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}`} htmlFor={inputId} key={option.frequency}>
              <input id={inputId} type="checkbox" value={option.frequency} checked={selected} disabled={disabled} onChange={() => toggleFrequency(option.frequency)} />
              <span><strong>{option.frequency} Hz</strong><small>{option.description}</small></span>
            </label>;
          })}</div><small id="frequency-help" className="frequency-help">Choose up to three. These descriptions reflect traditional associations, not proven medical or sleep benefits. Keep the volume comfortable.</small></fieldset>
        </div>
        {message && <div className="alert" role="alert">{message}</div>}
        <div className="panel-actions"><button className="btn btn-secondary" onClick={() => setStep(2)}>← Back</button><button className="btn btn-primary" onClick={createScript} disabled={Boolean(busy) || (Boolean(data.sourceUrl.trim()) && !data.sourceRightsAttested)}>{busy === "script" ? "Writing softly…" : "Write this bedtime →"}</button></div>
      </section>}

      {step === 4 && <section className="panel">
        <h2>Review, preview, then save</h2><p className="panel-intro">You have final say. Edit anything that doesn’t sound {narrationKind === "demo_narrator" ? "right" : "like you"}, then listen to a 30-second sample before generating the full bedtime.</p>
        {source && <div className="source-note"><strong>Inspired by:</strong> {source.title}{source.creator ? ` · ${source.creator}` : ""}<br /><small>Original wording generated from title/channel metadata only.</small></div>}
        <div className="field"><label htmlFor="script">Tonight’s script</label><textarea id="script" style={{ minHeight: 310, lineHeight: 1.75 }} value={script} onChange={(event) => { setScript(event.target.value); clearGeneratedAudio(); }} /></div>
        {previewAudioUrl && !savedAudioUrl && <div className="alert success"><strong>Your 30-second {narrationKind === "demo_narrator" ? "standard narrator" : "voice"} sample is ready.</strong><div style={{ marginTop: 10 }}><SleepPlayer src={previewAudioUrl} sound={data.sound} frequencies={data.frequencies} /></div><p style={{ margin: "9px 0 0" }}>If it sounds right, save the full bedtime below.</p></div>}
        {savedAudioUrl && <div className="alert success"><strong>Your full bedtime is saved to My nights.</strong><div style={{ marginTop: 10 }}><SleepPlayer src={savedAudioUrl} sound={data.sound} frequencies={data.frequencies} /></div><div style={{ marginTop: 12 }}><a className="btn btn-primary btn-small" href="/library">Open My nights →</a></div>{savedSessionId && <span className="sr-only">Saved session {savedSessionId}</span>}</div>}
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
