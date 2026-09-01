import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Panel, PanelRow } from './Panel';

describe('Panel', () => {
  it('renders its title and children', () => {
    render(
      <Panel title="Needs attention">
        <PanelRow>Row one</PanelRow>
        <PanelRow>Row two</PanelRow>
      </Panel>
    );
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Row one')).toBeInTheDocument();
    expect(screen.getByText('Row two')).toBeInTheDocument();
  });
});
