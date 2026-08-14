import type { Metadata } from "next";
import { ProductHub } from "@/components/ProductHub";
import { getProduct } from "@/lib/nearyoustill-products";

const product = getProduct("nearlegacy");
export const metadata: Metadata = { title: product.metadataTitle, description: product.metadataDescription, alternates: { canonical: product.path } };
export default function NearLegacyHub() { return <ProductHub product={product} />; }
