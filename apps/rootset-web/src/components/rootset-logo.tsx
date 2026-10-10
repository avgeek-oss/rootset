import Image from "next/image";

export function RootsetLogo() {
  return (
    <Image
      src="/brand/rootset-logo.png"
      alt=""
      aria-hidden="true"
      width={32}
      height={32}
      className="rootset-logo"
      unoptimized
    />
  );
}
