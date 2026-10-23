// >>> range3d button
// Adds a link to the ADS-B Antenna Range Visualizer. This is appended to tar1090's
// html/config.js, which tar1090-update preserves, so the button survives updates
// without anything being forked. Delete this block to remove the button.
(function () {
    if (window.__range3dButtonAdded) { return; }
    window.__range3dButtonAdded = true;
    var tries = 0;
    function add() {
        if (document.getElementById('range3d_button')) { return; }
        var anchor = document.getElementById('toggle_sidebar_control');
        if (!anchor || !anchor.parentNode) {
            if (tries++ < 40) { setTimeout(add, 250); }
            return;
        }
        var link = document.createElement('a');
        link.id = 'range3d_button';
        link.href = '/range3d/';
        link.target = '_blank';
        link.rel = 'noopener';
        link.title = 'Coverage envelope in 3D, resolved by altitude';
        link.textContent = '3D';
        link.style.cssText = [
            'display:inline-block',
            'margin-left:4px',
            'padding:2px 6px',
            'font:11px/1.4 ui-monospace,monospace',
            'letter-spacing:0.06em',
            'color:#d8d8d8',
            'background:#161616',
            'border:1px solid #3d3d3d',
            'text-decoration:none',
            'vertical-align:middle'
        ].join(';');
        anchor.parentNode.insertBefore(link, anchor.nextSibling);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', add);
    } else {
        add();
    }
})();
// <<< range3d button
