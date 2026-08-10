import type { AnchorHTMLAttributes } from "react";

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
};

export function Link({ children, href, ...props }: LinkProps) {
  return <a href={href} {...props}>{children}</a>;
}
