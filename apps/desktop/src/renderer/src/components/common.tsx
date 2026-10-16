import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useUi } from '../state/ui';

/** Icon button whose tooltip always shows the keyboard shortcut. */
export function IconButton(props: {
  icon: ReactNode;
  label: string;
  kbd?: string;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  small?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-btn${props.active ? ' active' : ''}${props.small ? ' small' : ''}${props.className ? ` ${props.className}` : ''}`}
      aria-label={props.label}
      aria-pressed={props.active}
      data-tip={props.label}
      data-kbd={props.kbd}
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon}
    </button>
  );
}

export function Kbd({ keys }: { keys: string }) {
  return (
    <>
      {keys.split(' / ').map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </>
  );
}

/**
 * One tooltip for the whole app: any element with data-tip (and optionally data-kbd)
 * gets a tooltip on hover. Keeps the DOM light and the look consistent.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; kbd?: string; x: number; y: number; above: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      current.current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el === current.current) return;
      hide();
      if (!el) return;
      current.current = el;
      timer.current = setTimeout(() => {
        if (!el.isConnected) return;
        const r = el.getBoundingClientRect();
        const above = r.bottom + 40 > window.innerHeight;
        setTip({
          text: el.dataset.tip ?? '',
          kbd: el.dataset.kbd || undefined,
          x: Math.min(Math.max(8, r.left + r.width / 2), window.innerWidth - 8),
          y: above ? r.top - 6 : r.bottom + 6,
          above,
        });
      }, 450);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  if (!tip) return null;
  return <TooltipBox {...tip} />;
}

function TooltipBox({ text, kbd, x, y, above }: { text: string; kbd?: string; x: number; y: number; above: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(x);
  useEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    setLeft(Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8));
  }, [x, text, kbd]);
  return (
    <div ref={ref} className="tooltip" style={{ left, top: y, transform: above ? 'translateY(-100%)' : undefined }}>
      <span>{text}</span>
      {kbd && <Kbd keys={kbd} />}
    </div>
  );
}

export function Modal(props: { title: string; icon?: ReactNode; children: ReactNode; footer?: ReactNode; onClose?: () => void; wide?: boolean; testId?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && props.onClose) {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props.onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-label={props.title} data-testid={props.testId}>
        <div className="modal-head">
          {props.icon}
          <h2>{props.title}</h2>
          <div className="grow" />
          {props.onClose && <IconButton icon={<X size={16} />} label="Close" kbd="Esc" onClick={props.onClose} small />}
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 100 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatEta(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return 'estimating…';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s left`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m left`;
}
