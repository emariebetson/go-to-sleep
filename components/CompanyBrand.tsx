import { Link } from "./Link";

export function CompanyBrand({ light = false }: { light?: boolean }) {
  return <Link className="company-brand" href="/" aria-label="NearYou Still home" style={light ? { color: "white" } : undefined}>
    <span className="company-brand-mark" aria-hidden="true"><i /><i /><i /></span>
    <span><strong>NearYou</strong><small>Still</small></span>
  </Link>;
}
