import { UI_SCALE_DEFAULT, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from "../../shared/ui-scale";
import { Modal } from "./ui";

export function SettingsModal({
  scale,
  onChange,
  onClose,
}: {
  scale: number;
  onChange: (value: number) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Settings"
      subtitle="Workspace appearance"
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="btn ghost" onClick={() => onChange(UI_SCALE_DEFAULT)} disabled={scale === UI_SCALE_DEFAULT}>
            Reset to 100%
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <section className="settings-section" aria-labelledby="settings-scale-heading">
        <div className="settings-section-head">
          <div>
            <span className="eyebrow">INTERFACE</span>
            <h3 id="settings-scale-heading">UI scale</h3>
          </div>
          <strong className="settings-scale-value" aria-live="polite">
            {scale}%
          </strong>
        </div>
        <p className="settings-help">
          Scales the entire Nexus workspace, including text and controls. Changes apply after a moment and are saved on this computer.
        </p>
        <input
          className="settings-range"
          type="range"
          min={UI_SCALE_MIN}
          max={UI_SCALE_MAX}
          step={UI_SCALE_STEP}
          value={scale}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          aria-label="UI scale"
          aria-valuetext={`${scale} percent`}
        />
        <div className="settings-range-labels" aria-hidden="true">
          <span>{UI_SCALE_MIN}%</span>
          <span>{UI_SCALE_DEFAULT}%</span>
          <span>{UI_SCALE_MAX}%</span>
        </div>
      </section>
    </Modal>
  );
}
