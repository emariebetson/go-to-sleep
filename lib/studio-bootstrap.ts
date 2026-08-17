type StudioFetcher = typeof fetch;

export type StudioBootstrap = {
  onboarding: Response | null;
  children: Response | null;
  voices: Response;
};

const jsonRequest = { headers: { accept: "application/json" } };

export async function loadStudioBootstrap(productionMode: boolean, fetcher: StudioFetcher = fetch): Promise<StudioBootstrap> {
  if (!productionMode) {
    return { onboarding: null, children: null, voices: await fetcher("/api/voices", jsonRequest) };
  }
  const [onboarding, children, voices] = await Promise.all([
    fetcher("/api/onboarding", jsonRequest),
    fetcher("/api/v1/children", jsonRequest),
    fetcher("/api/voices", jsonRequest),
  ]);
  return { onboarding, children, voices };
}
