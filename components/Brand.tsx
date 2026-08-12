import { Link } from "./Link";

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <Link className="brand" href="/" aria-label="NearSleep by NearYou home" data-nearyou-product="NearSleep" style={light ? { color: "white" } : undefined}>
      <span className="brand-mark" aria-hidden="true"><span className="brand-dot" /></span>
      <span>NearSleep</span>
    </Link>
  );
}
