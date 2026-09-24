document.getElementById('footer-year').textContent = new Date().getFullYear();
document.getElementById('footer-methodology').addEventListener('click', () => document.getElementById('flow-methodology').showModal());
document.getElementById('footer-pricing').addEventListener('click', () => document.getElementById('footer-pricing-dialog').showModal());
document.getElementById('footer-pricing-close').addEventListener('click', () => document.getElementById('footer-pricing-dialog').close());
