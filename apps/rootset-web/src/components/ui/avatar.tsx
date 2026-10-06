// Adapted from the Apache-2.0 Towbar and Mill web design systems.
// Adapted from Towbar's Apache-2.0 web-design-system Avatar.
"use client";

import { Avatar as HeroAvatar } from "@heroui/react";
import { useEffect, useState, type ComponentProps } from "react";
import { cn } from "./utils";

export type AvatarProps = Omit<
  ComponentProps<typeof HeroAvatar>,
  "children"
> & {
  email: string;
  name?: string;
  src?: string;
};

export function Avatar({ email, name, src, className, ...props }: AvatarProps) {
  const normalizedEmail = email.trim().toLowerCase();
  const [image, setImage] = useState<{ email: string; url: string } | null>(
    null,
  );
  const words = (name?.trim() || normalizedEmail.split("@")[0] || "?")
    .split(/[\s._-]+/u)
    .filter(Boolean);
  const initials = [words[0]?.[0], words.length > 1 ? words.at(-1)?.[0] : ""]
    .join("")
    .toUpperCase();

  useEffect(() => {
    if (!normalizedEmail || !globalThis.crypto?.subtle) return;
    let active = true;
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(normalizedEmail))
      .then((digest) => {
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        if (active)
          setImage({
            email: normalizedEmail,
            url: `https://www.gravatar.com/avatar/${hash}?s=160&d=404&r=g`,
          });
      })
      .catch(() => {
        if (active) setImage(null);
      });
    return () => {
      active = false;
    };
  }, [normalizedEmail]);

  return (
    <HeroAvatar
      aria-label={name?.trim() || normalizedEmail || "User"}
      className={cn("shrink-0 rounded-lg", className)}
      data-slot="avatar"
      role="img"
      {...props}
    >
      <HeroAvatar.Image
        key={normalizedEmail}
        alt=""
        className="object-cover"
        referrerPolicy="no-referrer"
        src={src ?? (image?.email === normalizedEmail ? image.url : undefined)}
      />
      <HeroAvatar.Fallback
        aria-hidden="true"
        data-slot="avatar-fallback"
        className="text-[10px] font-normal text-muted"
      >
        {initials}
      </HeroAvatar.Fallback>
    </HeroAvatar>
  );
}
