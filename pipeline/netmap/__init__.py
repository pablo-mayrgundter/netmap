"""netmap: maps of cyberspace.

Pipeline that turns AS-level routing data (CAIDA AS relationships, RouteViews
prefix-to-AS, DB-IP geolocation) into layered internet maps:

* ``cyber``  - pure graph layout (Large Graph Layout, a la the Opte project)
* ``geo``    - every AS pinned to where its address space lives
* ``hybrid`` - geographically concentrated ASes pinned, the global core
               laid out by the graph between them (and lifted in 3D)
"""

__version__ = "0.1.0"
