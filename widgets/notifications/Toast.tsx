import React from 'react';
import { Button } from 'widgets/button';

interface IToast {
  message: string;
  // "action" apparently is a reserverd keyword, it gets removed by mobx...
  clickAction?: React.ReactNode;
  timeout: number;
  onDismiss: () => void;
  type?: 'info' | 'success' | 'warning' | 'error';
  compact?: boolean;
}

export const Toast = ({ message, clickAction, onDismiss, type = 'info', compact }: IToast) => {
  return (
    <div className={`toast toast-${type} ${compact ? 'compact' : ''}`}>
      <span>{message}</span>
      {clickAction}
      <Button text="Dismiss" onClick={onDismiss} />
    </div>
  );
};
