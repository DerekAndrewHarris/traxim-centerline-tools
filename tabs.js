/**
 * Tab Switching Logic
 * Handles switching between OSM Workflow and Centerline Conversion tabs
 */

document.addEventListener('DOMContentLoaded', function() {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
        button.addEventListener('click', function() {
            const targetTab = this.getAttribute('data-tab');

            // Remove active class from all buttons and contents
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));

            // Add active class to clicked button and corresponding content
            this.classList.add('active');
            document.getElementById(`tab-${targetTab}`).classList.add('active');

            // If switching to OSM tab, invalidate map size (Leaflet needs this)
            if (targetTab === 'osm' && window.osmMap) {
                setTimeout(() => {
                    window.osmMap.invalidateSize();
                }, 100);
            }
        });
    });
});
