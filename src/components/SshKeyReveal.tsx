import { useState } from "react";
import type { SshKeyIssueResult } from "../../shared/types";
import { Icon } from "./Icon";
import { Modal, type ToastItem } from "./ui";

/**
 * One-time reveal for a member's private key. The key exists only in this
 * component's props: closing the modal (or rotating the key) discards it.
 */
export function SshKeyReveal({
  result,
  onClose,
  onToast,
}: {
  result: SshKeyIssueResult;
  onClose: () => void;
  onToast?: (level: ToastItem["level"], title: string, detail?: string) => void;
}) {
  const [copied, setCopied] = useState<"key" | "command" | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const filename = `nexus-${result.key.assignedTo?.username ?? result.key.owner}-${result.host.label.replace(/[^\w.-]+/g, "-")}.key`;

  const copy = async (value: string, kind: "key" | "command") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_800);
    } catch (err) {
      onToast?.("error", "Clipboard unavailable", err instanceof Error ? err.message : String(err));
    }
  };

  const download = () => {
    const blob = new Blob([result.privateKey.endsWith("\n") ? result.privateKey : `${result.privateKey}\n`], {
      type: "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setCopied("key");
    onToast?.("ok", "Private key downloaded", filename);
  };

  return (
    <Modal
      title={`SSH key for ${result.key.assignedTo?.displayName ?? result.key.owner}`}
      subtitle={`${result.host.label} · ${result.host.username}@${result.host.host}:${result.host.port}`}
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={onClose} disabled={!acknowledged}>
            <Icon name="check" size={13} /> {acknowledged ? "I saved the key" : "Save the key first"}
          </button>
        </>
      }
    >
      <div className="sshkey-reveal">
        <div className="sshkey-reveal-warning">
          <span className="sshkey-reveal-warning-mark">
            <Icon name="alert" size={16} />
          </span>
          <div>
            <strong>This private key is shown once.</strong>
            <p>
              Nexus keeps only an encrypted copy in its vault and will not show it again. Save it now, set permissions to{" "}
              <code>600</code>, and delete it from downloads after installing it on the user's computer.
            </p>
          </div>
        </div>

        <div className="sshkey-reveal-grid">
          <div>
            <span>Fingerprint</span>
            <code>{result.fingerprint}</code>
          </div>
          <div>
            <span>Authorized file</span>
            <code>{result.path}</code>
          </div>
          <div>
            <span>Account</span>
            <code>
              {result.host.username}@{result.host.host}:{result.host.port}
            </code>
          </div>
          <div>
            <span>Key label</span>
            <code>{result.key.label}</code>
          </div>
        </div>

        {result.warning ? <div className="sshkey-reveal-note">{result.warning}</div> : null}

        <div className="sshkey-reveal-block">
          <div className="sshkey-reveal-block-head">
            <span>Private key</span>
            <div className="inline-actions">
              <button className="btn small ghost" onClick={() => void copy(result.privateKey, "key")}>
                <Icon name="copy" size={12} /> {copied === "key" ? "Copied" : "Copy"}
              </button>
              <button className="btn small primary" onClick={download}>
                <Icon name="download" size={12} /> Download {filename}
              </button>
            </div>
          </div>
          <pre className="sshkey-reveal-key">{result.privateKey}</pre>
        </div>

        <div className="sshkey-reveal-block">
          <div className="sshkey-reveal-block-head">
            <span>Direct SSH command</span>
            <button className="btn small ghost" onClick={() => void copy(result.connect, "command")}>
              <Icon name="copy" size={12} /> {copied === "command" ? "Copied" : "Copy"}
            </button>
          </div>
          <code className="sshkey-reveal-command">{result.connect}</code>
        </div>

        <label className="sshkey-reveal-ack">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>I saved this key and understand Nexus will not show it again.</span>
        </label>
      </div>
    </Modal>
  );
}
