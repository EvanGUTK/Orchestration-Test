import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

export type Route = { path: string; segments: string[]; params: URLSearchParams };

export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart = "", queryPart = ""] = raw.split("?", 2);
  const path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const segments = path.split("/").filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { path: `/${segments.join("/")}`, segments, params: new URLSearchParams(queryPart) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function useNavigate(): (path: string) => void {
  return useCallback((path: string) => {
    const target = path.startsWith("#") ? path : `#${path}`;
    if (window.location.hash === target) window.dispatchEvent(new HashChangeEvent("hashchange"));
    else window.location.hash = target;
  }, []);
}

export function Link(props: { to: string; className?: string; children: ReactNode; "aria-label"?: string }) {
  return (
    <a href={`#${props.to}`} className={props.className} aria-label={props["aria-label"]}>
      {props.children}
    </a>
  );
}
