import { fetchWithTimeout } from "./http";

export type ScriptInput = {
  childName: string;
  ageMonths: string;
  challenge: string;
  theme: string;
  duration: string;
  style: string;
  scriptMode: "curated" | "personalized";
};

const labels: Record<string, string> = {
  "moonlit-meadow": "a moonlit meadow with quiet fireflies",
  "sleepy-sea": "a sleepy sea with tiny, gentle waves",
  "cloud-garden": "a soft cloud garden with floating flowers",
  settling: "settling into bedtime",
  "frequent-waking": "returning calmly to the bedtime rhythm",
  separation: "feeling a parent's familiar closeness",
  overtired: "letting an overtired evening soften",
  "nap-transition": "finding a new rest rhythm",
  "slow-story": "slow, warm storytelling",
  rhythmic: "rhythmic repetition with natural pauses",
  lullaby: "lullaby-like phrasing without written song lyrics",
};

function clean(value: string, limit = 64) {
  return value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function validateScriptInput(input: Partial<ScriptInput>): ScriptInput {
  const allowed = {
    challenge: ["settling", "frequent-waking", "separation", "overtired", "nap-transition"],
    theme: ["moonlit-meadow", "sleepy-sea", "cloud-garden"],
    duration: ["5", "10", "15", "20"],
    style: ["slow-story", "rhythmic", "lullaby"],
    scriptMode: ["curated", "personalized"],
  } as const;
  const childName = clean(input.childName || "", 32);
  if (!childName) throw new Error("A baby nickname is required.");
  const age = Math.max(0, Math.min(24, Number.parseInt(input.ageMonths || "0", 10) || 0));
  for (const key of Object.keys(allowed) as Array<keyof typeof allowed>) {
    if (!allowed[key].includes((input[key] || "") as never)) throw new Error(`Invalid ${key}.`);
  }
  return { childName, ageMonths: String(age), challenge: input.challenge!, theme: input.theme!, duration: input.duration!, style: input.style!, scriptMode: input.scriptMode! };
}

export function curatedScript(input: ScriptInput) {
  const name = input.childName;
  const world = labels[input.theme];
  const repeatCount = Math.max(2, Math.round(Number(input.duration) / 3));
  const middle = Array.from({ length: repeatCount }, (_, index) => {
    const details = ["a warm little light rests nearby", "the quiet air moves slowly", "every small sound becomes softer", "the moon keeps gentle watch"][index % 4];
    return `${name} drifts through ${world}. ${details}. Nothing needs to hurry. Nothing needs to happen next. The story can pause, and the room can be quiet.`;
  }).join("\n\n");

  return `Hello, sweet ${name}. The room is growing quiet now. Your grown-up is close, and this familiar voice is here with you.\n\nTonight we are visiting ${world}. We will move very slowly. We will leave lots of room for yawns, wiggles, and little pauses.\n\n${middle}\n\nThe story is getting smaller now, like a tiny light tucked safely inside a lantern. The words can grow softer. The quiet can grow longer.\n\nGoodnight, ${name}. You are loved. Your grown-up is near. The story can rest now.`;
}

export async function personalizedScript(input: ScriptInput) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Personalized writing is not configured yet. Choose the curated option for now.");
  const targetWords = Math.min(1500, Math.max(300, Number(input.duration) * 80));
  const instructions = `You write calm bedtime narration for an adult parent to play for their baby. This is a wellbeing product, not medical advice or sleep training. Write only the final narration. Use short, warm sentences and generous paragraph breaks. The parent must be able to review the script before audio generation. Never promise sleep, mention hypnosis, diagnose, give medical or safe-sleep positioning advice, instruct a caregiver to ignore crying, shame the baby, use fear or peril, include startling sounds, introduce strangers, or say the baby is alone. Do not write copyrighted lyrics. Do not claim the baby understands or should follow complex instructions. Mention that the grown-up is near no more than twice. Use the nickname naturally, not in every paragraph. Aim for about ${targetWords} words; gentle repetition is welcome.`;
  const prompt = `Baby nickname: ${input.childName}\nAge: ${input.ageMonths} months\nBedtime context: ${labels[input.challenge]}\nStory world: ${labels[input.theme]}\nNarration style: ${labels[input.style]}\nRequested duration: ${input.duration} minutes`;
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-5-mini", instructions, input: prompt, max_output_tokens: 2600 }),
  }, 45_000);
  if (!response.ok) throw new Error(`Personalized writing is temporarily unavailable (${response.status}).`);
  const payload = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!text?.trim()) throw new Error("The personalized script was empty. Please try again.");
  return text.trim();
}
