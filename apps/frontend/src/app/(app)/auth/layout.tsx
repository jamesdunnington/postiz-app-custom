export const dynamic = 'force-dynamic';
import { ReactNode } from 'react';
import Image from 'next/image';
import loadDynamic from 'next/dynamic';
const ReturnUrlComponent = loadDynamic(() => import('./return.url.component'));

export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div
      className="light min-h-screen w-full flex items-center justify-center px-4 py-12"
      style={{ background: '#F5EDD8' }}
    >
      <ReturnUrlComponent />

      {/* Neo-Brutalist card */}
      <div
        className="w-full flex flex-col"
        style={{
          maxWidth: '460px',
          background: '#FDF8EE',
          border: '3px solid #1C1208',
          boxShadow: '6px 6px 0 0 #1C1208',
          padding: '40px 40px 32px',
        }}
      >
        {/* Logo + brand name */}
        <div className="flex items-center gap-3 mb-8 pb-6" style={{ borderBottom: '2px solid #1C1208' }}>
          <Image
            src="/content-warrior.svg"
            width={48}
            height={48}
            alt="TheContentWarrior"
          />
          <div
            style={{
              fontWeight: 900,
              fontSize: '1.25rem',
              color: '#1C1208',
              letterSpacing: '-0.02em',
              lineHeight: 1.1,
            }}
          >
            The<br />
            <span style={{ color: '#B5451B' }}>Content</span>
            <span style={{ color: '#1C1208' }}>Warrior</span>
          </div>
        </div>

        {/* Auth form content */}
        <div className="text-[#1C1208]">{children}</div>
      </div>

      {/* Brutalist decorative offset block */}
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          right: 0,
          width: '180px',
          height: '180px',
          background: '#B5451B',
          opacity: 0.12,
          zIndex: 0,
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '120px',
          height: '120px',
          background: '#4A7C59',
          opacity: 0.12,
          zIndex: 0,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
