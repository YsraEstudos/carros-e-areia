import React, { useMemo, useState } from 'react';
import { Download, ExternalLink, Laptop, Smartphone, X, Zap } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
  onActivateMaxPerformance?: () => void;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  compact = false,
  onActivateMaxPerformance,
}) => {
  const {
    isInstallable,
    isInstalled,
    isIOS,
    isAndroid,
    isInIframe,
    install,
  } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  const standaloneUrl = useMemo(() => {
    if (typeof window === 'undefined') return '/?launch=standalone';
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('launch', 'standalone');
      return url.toString();
    } catch {
      return '/?launch=standalone';
    }
  }, []);

  // Automatically suppress install prompt when already running as an installed standalone PWA
  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      const accepted = await install();
      if (accepted) return;
    }
    setShowGuide(true);
  };

  return (
    <>
      <button
        type="button"
        draggable={false}
        onContextMenu={(e) => e.preventDefault()}
        onClick={handleClick}
        data-testid={compact ? 'mobile-pwa-install-btn' : 'desktop-pwa-install-btn'}
        aria-label="Baixar aplicativo para PC ou celular com performance máxima"
        title="Baixar App (PC e Celular) — Ultra + FPS Livre"
        className={
          compact
            ? 'touch-tap flex h-8 w-[30px] items-center justify-center gap-1 rounded-xl border border-[#e89b3c]/70 bg-[#2a1f14] text-xs font-semibold text-[#f8e7ce] shadow-lg active:bg-[#3a2a19] whitespace-nowrap min-[430px]:w-auto min-[430px]:px-2'
            : 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#e89b3c]/70 bg-[#2a1f14] px-2.5 font-sans text-xs font-semibold text-[#f8e7ce] transition-colors hover:bg-[#3a2a19] whitespace-nowrap'
        }
      >
        <Download className="h-3.5 w-3.5 shrink-0 text-[#e89b3c]" aria-hidden="true" />
        <span className={compact ? 'hidden min-[430px]:inline' : undefined}>
          {compact ? 'Baixar' : 'Baixar App'}
        </span>
      </button>

      {showGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-dialog-title"
          className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          onClick={() => setShowGuide(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-[#f5efe6]/16 bg-[#14110e] p-5 text-[#f8f3eb] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2
                  id="pwa-install-dialog-title"
                  className="text-base font-semibold tracking-tight text-[#f8f3eb]"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  Baixar DuneFlow (PC &amp; Celular)
                </h2>
                <p className="mt-1 text-xs text-[#c7b9a5]">
                  Modo instalado offline com cache local do Rivian R1T e liberação total da GPU em Ultra + FPS Livre.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Fechar janela de instalação"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#f5efe6]/14 bg-[#1d1814] text-[#e6dac8] hover:bg-[#2a221c]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4 space-y-2.5">
              {isInstallable && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await install();
                    if (ok) setShowGuide(false);
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#e89b3c] px-4 py-2.5 text-xs font-semibold text-[#17120d] transition-colors hover:bg-[#f2a84a]"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  <span>Instalar Aplicativo Agora</span>
                </button>
              )}

              {(isInIframe || !isInstallable) && (
                <a
                  href={standaloneUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setShowGuide(false)}
                  data-testid="open-standalone-window-link"
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#e89b3c] px-4 py-2.5 text-xs font-semibold text-[#17120d] transition-colors hover:bg-[#f2a84a]"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  <span>Abrir Fora da Prévia (Instalar &amp; Máx. FPS)</span>
                </a>
              )}

              {onActivateMaxPerformance && (
                <button
                  type="button"
                  onClick={() => {
                    onActivateMaxPerformance();
                    setShowGuide(false);
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#e89b3c]/45 bg-[#201912] px-4 py-2 text-xs font-medium text-[#f2b25c] transition-colors hover:bg-[#2c2218]"
                >
                  <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Ativar Ultra + FPS Livre nesta sessão</span>
                </button>
              )}
            </div>

            <div className="mt-4 space-y-2.5 rounded-xl border border-[#f5efe6]/10 bg-[#0d0b09] p-3.5 text-xs text-[#cbbca8]">
              <div className="flex items-start gap-2.5">
                <Laptop className="mt-0.5 h-4 w-4 shrink-0 text-[#e89b3c]" aria-hidden="true" />
                <div>
                  <div className="font-semibold text-[#f8f3eb]">No PC (Chrome / Edge)</div>
                  <p className="mt-0.5 leading-relaxed">
                    {isInIframe
                      ? 'Clique em "Abrir Fora da Prévia" acima e depois no ícone de instalação na barra de endereço (ou Menu → Aplicativos → Instalar DuneFlow).'
                      : 'Clique no ícone Instalar na barra de endereço do navegador (ou Menu → Aplicativos → Instalar DuneFlow).'}
                  </p>
                </div>
              </div>

              <div className="h-px bg-[#f5efe6]/8" aria-hidden="true" />

              <div className="flex items-start gap-2.5">
                <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-[#e89b3c]" aria-hidden="true" />
                <div>
                  <div className="font-semibold text-[#f8f3eb]">
                    {isIOS
                      ? 'No iPhone / iPad (Safari)'
                      : isAndroid
                        ? 'No Celular Android (Chrome / Edge)'
                        : 'No Celular (Android / iPhone)'}
                  </div>
                  {isIOS ? (
                    <p className="mt-0.5 leading-relaxed">
                      Abra em janela dedicada acima, toque em <strong>Compartilhar</strong> no Safari e escolha{' '}
                      <strong>Adicionar à Tela de Início</strong>.
                    </p>
                  ) : (
                    <p className="mt-0.5 leading-relaxed">
                      Abra em janela dedicada acima, toque no menu (⋮) e selecione{' '}
                      <strong>Instalar aplicativo</strong> (Android) ou{' '}
                      <strong>Compartilhar → Adicionar à Tela de Início</strong> (iPhone).
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-40 rounded-lg border border-[#e89b3c]/50 bg-[#1a140d] px-3 py-1.5 text-xs font-medium text-[#f2b25c] shadow-lg"
    >
      Modo Offline — Cache local ativo
    </div>
  );
};
