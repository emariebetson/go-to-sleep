import type { Metadata } from "next";
import { ProductHub } from "@/components/ProductHub";
import { getProduct } from "@/lib/nearyoustill-products";

const product = getProduct("nearfamily");
export const metadata: Metadata = { title: product.metadataTitle, description: product.metadataDescription, alternates: { canonical: product.path } };
export default function NearFamilyHub() { return <ProductHub product={product} />; }
