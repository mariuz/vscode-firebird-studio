import * as assert from 'assert';
import { RESULTS_PANEL_OPTIONS } from '../result-view/queryResultsView';
import ResultView from '../result-view';
import { ProfilerView } from '../profiler';
import { SchemaDesigner } from '../schema-designer';
import { QueryPlanView } from '../query-plan-view';

suite('Webview retainContextWhenHidden configuration', () => {
  test('RESULTS_PANEL_OPTIONS enables retainContextWhenHidden and enableFindWidget', () => {
    assert.strictEqual(RESULTS_PANEL_OPTIONS.retainContextWhenHidden, true);
    assert.strictEqual(RESULTS_PANEL_OPTIONS.enableFindWidget, true);
  });

  test('ResultView inherits retainContextWhenHidden: true to protect staged edits and grid state', () => {
    const view = new ResultView('/mock/path');
    assert.strictEqual((view as any).retainContextWhenHidden, true);
    view.dispose();
  });

  test('SchemaDesigner inherits retainContextWhenHidden: true to protect diagram layout', () => {
    const designer = new SchemaDesigner('/mock/path');
    assert.strictEqual((designer as any).retainContextWhenHidden, true);
    designer.dispose();
  });

  test('QueryPlanView inherits retainContextWhenHidden: true to protect graph view state', () => {
    const planView = new QueryPlanView('/mock/path');
    assert.strictEqual((planView as any).retainContextWhenHidden, true);
    planView.dispose();
  });

  test('ProfilerView overrides retainContextWhenHidden: false to suspend webview polling on hide', () => {
    const profiler = new ProfilerView('/mock/path');
    assert.strictEqual((profiler as any).retainContextWhenHidden, false);
    profiler.dispose();
  });
});
