import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Image01Icon } from "@hugeicons/core-free-icons";

export function ImageCell({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);

  if (!src) return <span>—</span>;

  return (
    <span className="cell-image" title={src}>
      {failed ? (
        <HugeiconsIcon
          icon={Image01Icon}
          size={16}
          role="img"
          aria-label={`${name}: image unavailable`}
        />
      ) : (
        <img
          src={src}
          alt={`${name} image`}
          width={48}
          height={24}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
