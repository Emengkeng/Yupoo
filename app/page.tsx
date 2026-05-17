import Link from 'next/link';

export default function Home() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#0e0f11',
      color: '#d4d8e2',
      fontFamily: 'monospace',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 24,
    }}>
      <h1 style={{ color: '#f5a623', fontSize: 20 }}>Yupoo Importer</h1>
      <div style={{ display: 'flex', gap: 16 }}>
        <span style={{ color: '#6b7280', border: '1px solid #252830', padding: '8px 18px', borderRadius: 6 }}>
          <Link href="/yupoo-single" style={{ color: '#34d399', textDecoration: 'none', border: '1px solid #064e3b', padding: '8px 18px', borderRadius: 6 }}>
            /Single — Single Import →
          </Link>
        </span>
        <Link href="/batch-page" style={{ color: '#34d399', textDecoration: 'none', border: '1px solid #064e3b', padding: '8px 18px', borderRadius: 6 }}>
          /batch — Batch Import →
        </Link>
      </div>
    </div>
  );
}