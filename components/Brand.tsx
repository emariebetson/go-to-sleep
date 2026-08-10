import { Link } from "./Link";

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <Link className="brand" href="/" aria-label="Nearnight home" style={light ? { color: "white" } : undefined}>
      <span className="brand-mark" aria-hidden="true"><span className="brand-dot" /></span>
      <span>Nearnight</span>
    </Link>
  );
}
