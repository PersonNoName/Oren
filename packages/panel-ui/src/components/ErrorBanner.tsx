type Props = {
  error: string | null;
};

export function ErrorBanner({ error }: Props) {
  if (!error) return null;
  return (
    <div className="error-banner" role="alert">
      {error}
    </div>
  );
}
