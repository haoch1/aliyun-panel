import { Check, Copy } from "lucide-react";
import { Fragment, useState } from "react";
import type { ToastFn } from "../../../shared/types";
export function CopyText({
  text,
  toast,
  wrapAt,
}: {
  text?: string;
  toast: ToastFn;
  wrapAt?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!text) return <span className="muted">—</span>;
  return (
    <button
      className="copy-text"
      title="点击复制"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast("复制失败，请手动选择并复制", "error");
        }
      }}
    >
      <span>
        {wrapAt
          ? text.split(wrapAt).map((part, index) => (
              <Fragment key={index}>
                {index > 0 && (
                  <>
                    {wrapAt}
                    <wbr />
                  </>
                )}
                {part}
              </Fragment>
            ))
          : text}
      </span>
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
