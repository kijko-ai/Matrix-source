export const TeamEmptyState = (): React.JSX.Element => {
  return (
    <div className="flex size-full items-center justify-center">
      <div className="text-center">
        <p className="text-lg font-medium text-[var(--color-text)]">No teams found</p>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Create a team in Claude Code, then refresh the list.
        </p>
      </div>
    </div>
  );
};
