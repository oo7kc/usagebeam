project('usagebeam', version: '2.0.0-alpha.4-dev.0', license: 'MIT',
  meson_version: '>= 0.56.0',
  default_options: ['warning_level=0'])

uuid = 'usagebeam@oo7kc.github.io'
prefix = get_option('prefix')
extdir = join_paths(prefix, 'share', 'gnome-shell', 'extensions', uuid)
schemadir = join_paths(extdir, 'schemas')

install_data('extension.js', 'prefs.js', 'metadata.json', 'stylesheet.css', 'LICENSE',
  install_dir: extdir)

install_subdir('src', install_dir: extdir)
install_subdir('icons', install_dir: extdir)

install_data('schemas/org.gnome.shell.extensions.usagebeam.gschema.xml',
  install_dir: schemadir)

meson.add_install_script('build-aux/compile-schemas.sh', schemadir)
