# My Nights Navigation and Branded 404 Design

## Goal

Make every public-facing **My nights** action lead to the correct next step and replace the generic missing-page experience with a branded NearSleep 404 page.

## My nights behavior

The server determines the destination while rendering the page:

- An authenticated user receives a link to `/library`.
- An unauthenticated user receives a link to `/sign-in?returnTo=%2Flibrary`.
- The sign-in flow preserves `/library` as the safe relative return path.

The destination is resolved by one shared helper or component so the public header and 404 page cannot drift. The existing button labels and visual treatment remain unchanged.

The private `/library` page keeps its own authentication requirement. The session-aware link improves navigation but does not replace authorization at the destination.

## Branded 404 page

Create the framework-level `app/not-found.tsx` page so unmatched routes and calls to `notFound()` use a consistent NearSleep experience.

The page reuses the existing brand, button, type, color, spacing, and responsive systems. It includes:

- NearSleep header and brand mark.
- Eyebrow: `404 · A quiet detour`.
- Heading: `This page wandered off to sleep.`
- Reassurance that saved nights remain safe and private.
- Primary action to `/studio`.
- Secondary action to `/`.
- Session-aware **Open My nights** or **Sign in to My nights** action.
- A short `Nothing was changed or deleted.` reassurance.

The page does not introduce new imagery, fonts, dependencies, client state, or production feature flags.

## Accessibility and safety

- Use one semantic `h1` and descriptive link text.
- Preserve visible keyboard focus through the existing button system.
- Maintain usable mobile stacking through existing responsive patterns plus narrowly scoped 404 layout styles.
- Do not reveal whether private library records exist.
- Do not weaken session validation or product activation gates.

## Testing

Add behavior-focused tests that prove:

1. Authenticated navigation resolves **My nights** to `/library`.
2. Unauthenticated navigation resolves it to the safe sign-in return URL.
3. The public header uses the shared destination.
4. The global 404 renders the approved NearSleep copy and actions.
5. The 404 uses the same session-aware destination.
6. The existing safe-return-path behavior remains intact.

Run focused tests first, then TypeScript, scoped lint, the production build, and local browser verification for both the public header and an unknown route.

## Out of scope

- Changing `/library` data behavior or authentication requirements.
- Enabling NearStory, NearFamily, canary routes, schedulers, or infrastructure.
- Deploying or publishing the change before review.
